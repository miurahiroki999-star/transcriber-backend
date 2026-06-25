// ============================================================
// AI文字起こし + Premiere SRTメーカー バックエンド - server.js
// Render (Node.js + Express + ffmpeg-static + OpenAI API)
//
// エンドポイント：
//   GET  /api/health         ヘルスチェック
//   POST /api/transcribe     通常文字起こし（既存・変更なし）
//   POST /api/generate-srt   Premiere Pro用SRT生成
//
// 絶対ルール：
//   ・APIキーはここでのみ参照（フロントには絶対渡さない）
//   ・どんなエラーでも必ず JSON を返す
//   ・空レスポンスは禁止
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CORS設定
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ============================================================
// ファイルアップロード設定（multer）
// ============================================================
const upload = multer({
  dest: '/tmp/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB上限
  },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

// ============================================================
// ヘルスチェック
// GET /api/health
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Transcriber backend is running',
    time: new Date().toISOString(),
  });
});

// ============================================================
// 既存：通常文字起こしエンドポイント（変更なし）
// POST /api/transcribe
// ============================================================
app.post('/api/transcribe', upload.single('audioFile'), async (req, res) => {

  const uploadedPath = req.file ? req.file.path : null;
  const chunkPaths = [];

  const cleanup = () => {
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      chunkPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
    } catch (e) {
      console.error('クリーンアップエラー:', e.message);
    }
  };

  const sendError = (statusCode, message, details = '') => {
    cleanup();
    return res.status(statusCode).json({
      success: false,
      error: message,
      details: details || undefined,
    });
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendError(500, 'OPENAI_API_KEY が設定されていません。Render の環境変数を確認してください。');
  }

  if (!req.file) {
    return sendError(400, '音声ファイルがありません。ファイルを選択してください。');
  }

  const allowedModels = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
  const model = allowedModels.includes(req.body.model) ? req.body.model : 'whisper-1';

  const chunkMinutesRaw = parseInt(req.body.chunkMinutes, 10);
  const chunkMinutes = [5, 10, 15].includes(chunkMinutesRaw) ? chunkMinutesRaw : 10;
  const chunkSeconds = chunkMinutes * 60;

  const timecodeMode = req.body.timecodeMode === 'chunk' ? 'chunk' : 'segment';
  const isGpt4oModel = model === 'gpt-4o-mini-transcribe' || model === 'gpt-4o-transcribe';
  const useSegment = model === 'whisper-1' && timecodeMode === 'segment';

  console.log(`=== 文字起こし開始 ===`);
  console.log(`モデル: ${model}`);
  console.log(`タイムコードモード: ${timecodeMode}`);
  console.log(`分割単位: ${chunkMinutes}分（${chunkSeconds}秒）`);
  console.log(`ファイルサイズ: ${(req.file.size / 1024 / 1024).toFixed(1)}MB`);

  const timestamp = Date.now();
  const chunkPrefix = `/tmp/chunk_${timestamp}_`;
  const chunkPattern = `${chunkPrefix}%03d.mp3`;

  const ffmpegCmd = [
    `"${ffmpegPath}"`,
    '-y',
    `-i "${uploadedPath}"`,
    '-ac 1',
    '-ar 16000',
    '-b:a 32k',
    `-f segment`,
    `-segment_time ${chunkSeconds}`,
    `-reset_timestamps 1`,
    `"${chunkPattern}"`,
  ].join(' ');

  console.log('ffmpegコマンド実行中...');

  try {
    await execAsync(ffmpegCmd, { timeout: 600000 });
  } catch (err) {
    console.error('ffmpegエラー:', err.message);
    return sendError(500, 'ffmpegで音声の分割に失敗しました。音声ファイルの形式を確認してください。', err.message);
  }

  const tmpFiles = fs.readdirSync('/tmp').filter(f => f.startsWith(`chunk_${timestamp}_`) && f.endsWith('.mp3'));
  tmpFiles.sort();
  tmpFiles.forEach(f => chunkPaths.push(path.join('/tmp', f)));

  if (chunkPaths.length === 0) {
    return sendError(500, 'ffmpegで音声を分割できませんでした。音声ファイルが空か破損している可能性があります。');
  }

  console.log(`チャンク数: ${chunkPaths.length}`);

  const chunkResults = [];
  let fullText = '';

  if (isGpt4oModel) {
    fullText += `この結果は ${model} で文字起こししたため、発話セグメント単位のタイムコードではありません。正確な位置確認には whisper-1 を使用してください。\n\n`;
  }

  for (let i = 0; i < chunkPaths.length; i++) {
    const chunkPath = chunkPaths[i];
    const startSec = i * chunkSeconds;
    const chunkIndex = i + 1;

    console.log(`チャンク ${chunkIndex}/${chunkPaths.length} を処理中 (開始: ${startSec}秒)`);

    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(chunkPath), {
        filename: `chunk_${chunkIndex}.mp3`,
        contentType: 'audio/mpeg',
      });
      formData.append('model', model);
      formData.append('language', 'ja');

      if (useSegment) {
        formData.append('response_format', 'verbose_json');
        formData.append('timestamp_granularities[]', 'segment');
      } else {
        formData.append('response_format', 'json');
      }

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        let errMsg = '';
        try {
          const errJson = await response.json();
          errMsg = errJson?.error?.message || JSON.stringify(errJson);
        } catch {
          errMsg = await response.text().catch(() => '');
        }
        throw new Error(`OpenAI APIエラー (${response.status}): ${errMsg}`);
      }

      const result = await response.json();

      let chunkText = '';
      let segmentCount = 0;

      if (useSegment) {
        if (result.segments && result.segments.length > 0) {
          for (const seg of result.segments) {
            const absStart = startSec + seg.start;
            const tc = secondsToTimecode(absStart);
            chunkText += `${tc}\n${seg.text.trim()}\n\n`;
          }
          segmentCount = result.segments.length;
        } else {
          const tc = secondsToTimecode(startSec);
          chunkText = `${tc}\nwhisper-1 のセグメントタイムスタンプが取得できなかったため、この結果はチャンク単位のタイムコードです。\n${(result.text || '').trim()}\n\n`;
          segmentCount = 0;
        }
      } else if (model === 'whisper-1' && timecodeMode === 'chunk') {
        const tc = secondsToTimecode(startSec);
        chunkText = `${tc}\n${(result.text || '').trim()}\n\n`;
        segmentCount = 0;
      } else {
        const tc = secondsToTimecode(startSec);
        chunkText = `${tc}\n${(result.text || '').trim()}\n\n`;
        segmentCount = 0;
      }

      fullText += chunkText;

      chunkResults.push({
        index: chunkIndex,
        startSec,
        status: 'completed',
        segmentCount,
        timecodeMode: useSegment ? 'segment' : 'chunk',
      });

      console.log(`チャンク ${chunkIndex} 完了（segments: ${segmentCount}）`);

    } catch (err) {
      console.error(`チャンク ${chunkIndex} 失敗:`, err.message);
      chunkResults.push({
        index: chunkIndex,
        startSec,
        status: 'failed',
        segmentCount: 0,
        timecodeMode: useSegment ? 'segment' : 'chunk',
        error: err.message,
      });
      const tc = secondsToTimecode(startSec);
      fullText += `${tc}\n[チャンク${chunkIndex}の文字起こしに失敗しました: ${err.message}]\n\n`;
    }
  }

  cleanup();

  const failedCount = chunkResults.filter(c => c.status === 'failed').length;

  console.log(`=== 完了 ===`);
  console.log(`成功: ${chunkResults.length - failedCount} / ${chunkResults.length}`);

  return res.json({
    success: true,
    text: fullText.trim(),
    model,
    timecodeMode: useSegment ? 'segment' : 'chunk',
    totalChunks: chunkPaths.length,
    completedChunks: chunkResults.length - failedCount,
    failedChunks: failedCount,
    chunks: chunkResults,
  });

});

// ============================================================
// 新規：Premiere Pro用SRT生成エンドポイント
// POST /api/generate-srt
// ============================================================
app.post('/api/generate-srt', upload.single('audioFile'), async (req, res) => {

  const uploadedPath = req.file ? req.file.path : null;
  const chunkPaths = [];

  const cleanup = () => {
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      chunkPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
    } catch (e) {
      console.error('クリーンアップエラー:', e.message);
    }
  };

  const sendError = (statusCode, message, details = '') => {
    cleanup();
    return res.status(statusCode).json({
      success: false,
      error: message,
      details: details || undefined,
    });
  };

  // ── (1) APIキー確認 ──────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendError(500, 'OPENAI_API_KEY が設定されていません。Render の環境変数を確認してください。');
  }

  // ── (2) ファイル確認 ──────────────────────────────────
  if (!req.file) {
    return sendError(400, '音声ファイルがありません。ファイルを選択してください。');
  }

  // ── (3) パラメータ取得・バリデーション ──────────────────────────────────
  const chunkMinutesRaw = parseInt(req.body.chunkMinutes, 10);
  const chunkMinutes = [5, 10, 15].includes(chunkMinutesRaw) ? chunkMinutesRaw : 10;
  const chunkSeconds = chunkMinutes * 60;

  const charsPerLine = parseInt(req.body.charsPerLine, 10) || 14;
  const maxLines = parseInt(req.body.maxLines, 10) === 1 ? 1 : 2;
  const minDuration = parseFloat(req.body.minDuration) || 1.0;
  const maxDuration = parseFloat(req.body.maxDuration) || 4.0;
  const captionMode = ['context', 'short', 'seminar'].includes(req.body.captionMode)
    ? req.body.captionMode
    : 'context';
  const fixedDisplaySec = parseFloat(req.body.fixedDisplaySec) || 2.0;

  // ── 字幕終了タイミング関連（新規） ──────────────────────────────────
  const captionEndMode = ['speech_exact', 'min_duration', 'fixed'].includes(req.body.captionEndMode)
    ? req.body.captionEndMode
    : 'speech_exact';
  const endPaddingSec = parseFloat(req.body.endPaddingSec) || 0.1;

  const maxCaptionChars = charsPerLine * maxLines;

  const captionSettings = {
    chunkMinutes,
    charsPerLine,
    maxLines,
    minDuration,
    maxDuration,
    captionMode,
    maxCaptionChars,
    captionEndMode,  // speech_exact / min_duration / fixed
    endPaddingSec,   // 終了余白（秒）
    fixedDisplaySec, // fixedモード用固定表示秒数
  };

  console.log(`=== SRT生成開始 ===`);
  console.log(`設定: ${JSON.stringify(captionSettings)}`);
  console.log(`ファイルサイズ: ${(req.file.size / 1024 / 1024).toFixed(1)}MB`);

  // ── (4) ffmpegで音声を分割 ──────────────────────────────────
  const timestamp = Date.now();
  const chunkPrefix = `/tmp/srt_chunk_${timestamp}_`;
  const chunkPattern = `${chunkPrefix}%03d.mp3`;

  const ffmpegCmd = [
    `"${ffmpegPath}"`,
    '-y',
    `-i "${uploadedPath}"`,
    '-ac 1',
    '-ar 16000',
    '-b:a 32k',
    `-f segment`,
    `-segment_time ${chunkSeconds}`,
    `-reset_timestamps 1`,
    `"${chunkPattern}"`,
  ].join(' ');

  console.log('ffmpeg 分割中...');

  try {
    await execAsync(ffmpegCmd, { timeout: 600000 });
  } catch (err) {
    console.error('ffmpegエラー:', err.message);
    return sendError(500, 'ffmpegで音声の分割に失敗しました。ファイル形式を確認してください。', err.message);
  }

  const tmpFiles = fs.readdirSync('/tmp')
    .filter(f => f.startsWith(`srt_chunk_${timestamp}_`) && f.endsWith('.mp3'))
    .sort();
  tmpFiles.forEach(f => chunkPaths.push(path.join('/tmp', f)));

  if (chunkPaths.length === 0) {
    return sendError(500, 'ffmpegで音声を分割できませんでした。音声ファイルが空か破損している可能性があります。');
  }

  console.log(`チャンク数: ${chunkPaths.length}`);

  // ── (5) 各チャンクをOpenAI APIで文字起こし ──────────────────────────────────
  const chunkResults = [];
  const allWords = [];    // { word, start, end } の配列（絶対時刻）
  const allSegments = []; // fallback用
  let timingSource = 'word';
  let plainText = '';
  let failedChunks = 0;

  for (let i = 0; i < chunkPaths.length; i++) {
    const chunkPath = chunkPaths[i];
    const startSec = i * chunkSeconds;
    const chunkIndex = i + 1;

    console.log(`チャンク ${chunkIndex}/${chunkPaths.length} 処理中 (開始: ${startSec}秒)`);

    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(chunkPath), {
        filename: `srt_chunk_${chunkIndex}.mp3`,
        contentType: 'audio/mpeg',
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'ja');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');
      formData.append('timestamp_granularities[]', 'segment');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        let errMsg = '';
        try {
          const errJson = await response.json();
          errMsg = errJson?.error?.message || JSON.stringify(errJson);
        } catch {
          errMsg = await response.text().catch(() => '');
        }
        throw new Error(`OpenAI APIエラー (${response.status}): ${errMsg}`);
      }

      const result = await response.json();

      // プレーンテキスト蓄積
      if (result.text) {
        plainText += result.text.trim() + '\n';
      }

      // word timestamps を絶対時刻に変換して蓄積
      if (result.words && result.words.length > 0) {
        for (const w of result.words) {
          allWords.push({
            word: w.word,
            start: startSec + w.start,
            end: startSec + w.end,
          });
        }
        chunkResults.push({
          index: chunkIndex,
          startSec,
          status: 'completed',
          wordCount: result.words.length,
          timingSource: 'word',
        });
        console.log(`チャンク ${chunkIndex} 完了（words: ${result.words.length}）`);
      } else if (result.segments && result.segments.length > 0) {
        // word timestamps なし → segments fallback
        timingSource = 'segment';
        for (const seg of result.segments) {
          allSegments.push({
            text: seg.text,
            start: startSec + seg.start,
            end: startSec + seg.end,
          });
        }
        chunkResults.push({
          index: chunkIndex,
          startSec,
          status: 'completed',
          segmentCount: result.segments.length,
          timingSource: 'segment',
        });
        console.log(`チャンク ${chunkIndex} 完了（segments fallback: ${result.segments.length}）`);
      } else {
        // どちらも取れなかった
        timingSource = 'none';
        chunkResults.push({
          index: chunkIndex,
          startSec,
          status: 'failed',
          timingSource: 'none',
          error: 'word/segmentタイムスタンプが取得できませんでした',
        });
        failedChunks++;
        console.warn(`チャンク ${chunkIndex}: タイムスタンプなし`);
      }

    } catch (err) {
      console.error(`チャンク ${chunkIndex} 失敗:`, err.message);
      chunkResults.push({
        index: chunkIndex,
        startSec,
        status: 'failed',
        timingSource: 'none',
        error: err.message,
      });
      failedChunks++;
    }
  }

  // ── (6) SRT組み立て ──────────────────────────────────

  if (timingSource === 'none' || (allWords.length === 0 && allSegments.length === 0)) {
    cleanup();
    return res.status(500).json({
      success: false,
      error: 'word timestamps も segments も取得できませんでした。音声内容または形式を確認してください。',
    });
  }

  let captions = [];

  if (allWords.length > 0) {
    // ── word timestamps からSRT生成（改善版：文単位で組み立てる）
    timingSource = 'word';
    captions = buildCaptionsFromWords(allWords, captionSettings);
  } else {
    // ── segments fallback
    timingSource = 'segment';
    captions = buildCaptionsFromSegments(allSegments, captionSettings);
  }

  const srt = buildSrtString(captions);

  cleanup();

  const completedChunks = chunkResults.filter(c => c.status === 'completed').length;

  console.log(`=== SRT生成完了 ===`);
  console.log(`字幕数: ${captions.length}, タイミング源: ${timingSource}, 終了モード: ${captionEndMode}`);

  return res.json({
    success: true,
    srt,
    plainText: plainText.trim(),
    totalCaptions: captions.length,
    totalChunks: chunkPaths.length,
    completedChunks,
    failedChunks,
    captionSettings,
    chunks: chunkResults,
    timingSource,
    captionEndMode,
    ...(timingSource === 'segment'
      ? { warning: 'word timestamps が取得できなかったため、segments と文字数比でSRTを生成しました。タイミングは目安を含みます。' }
      : {}),
  });

});

// ============================================================
// SRT生成ロジック（改善版）：word timestamps から字幕を組み立てる
//
// 改善の考え方：
//   1. word timestampsは「時刻情報」としてのみ使う
//   2. 全wordを結合し、句点・疑問符・感嘆符で「文」に分割する
//   3. 各文の開始・終了はword timestampsから引く
//   4. 1文が収まるなら1字幕に。長い場合のみ読点→意味単位で分割
//   5. 文字数で切る場合も助詞先頭・末尾NG語を徹底チェックして回避
//   6. captionEndMode に応じて終了時刻の決定ロジックを切り替える
// ============================================================
function buildCaptionsFromWords(words, settings) {
  const { charsPerLine, maxLines, minDuration, maxDuration, captionMode,
          captionEndMode, endPaddingSec, fixedDisplaySec } = settings;
  const maxCaptionChars = charsPerLine * maxLines;

  // ── STEP1: 全wordを連結して文字列＋時刻マップを作る ──────────────────
  const fullText = words.map(w => w.word).join('');

  // 各文字位置がどのwordに対応するかのマップを作る
  const charToWordIndex = [];
  let pos = 0;
  for (let wi = 0; wi < words.length; wi++) {
    const wlen = words[wi].word.length;
    for (let ci = 0; ci < wlen; ci++) {
      charToWordIndex[pos] = wi;
      pos++;
    }
  }

  // ── STEP2: 句点・疑問符・感嘆符で「文」に分割する ──────────────────
  const sentenceBreakChars = new Set(['。', '！', '？', '!', '?']);
  const sentences = []; // { text, startCharIdx, endCharIdx }

  let sentStart = 0;
  for (let ci = 0; ci < fullText.length; ci++) {
    const ch = fullText[ci];
    if (sentenceBreakChars.has(ch)) {
      const sentText = fullText.slice(sentStart, ci + 1).trim();
      if (sentText.length > 0) {
        sentences.push({ text: sentText, startCharIdx: sentStart, endCharIdx: ci });
      }
      sentStart = ci + 1;
    }
  }
  // 末尾の句点なし残り
  if (sentStart < fullText.length) {
    const sentText = fullText.slice(sentStart).trim();
    if (sentText.length > 0) {
      sentences.push({ text: sentText, startCharIdx: sentStart, endCharIdx: fullText.length - 1 });
    }
  }

  // 文が0件の場合は全体を1文として扱う
  if (sentences.length === 0) {
    sentences.push({ text: fullText.trim(), startCharIdx: 0, endCharIdx: fullText.length - 1 });
  }

  // ── STEP3: 各文の開始・終了秒をword timestampsから取得する ──────────────────
  const sentencesWithTime = sentences.map(sent => {
    const safeStart = Math.min(sent.startCharIdx, charToWordIndex.length - 1);
    const safeEnd   = Math.min(sent.endCharIdx,   charToWordIndex.length - 1);
    const startWordIdx = charToWordIndex[safeStart] !== undefined ? charToWordIndex[safeStart] : 0;
    const endWordIdx   = charToWordIndex[safeEnd]   !== undefined ? charToWordIndex[safeEnd]   : words.length - 1;
    return {
      text: sent.text,
      start: words[startWordIdx].start,
      end: words[endWordIdx].end,
      startWordIdx,
      endWordIdx,
    };
  });

  // ── STEP4: 各文を字幕に変換する ──────────────────
  // 各字幕に startWordIdx / endWordIdx を引き継ぐ
  const rawCaptions = []; // { text, start, end, startWordIdx, endWordIdx, isWordIndexFallback }

  for (const sent of sentencesWithTime) {
    const subCaptions = splitSentenceIntoCaptions(
      sent.text, sent.start, sent.end,
      sent.startWordIdx, sent.endWordIdx,
      words, charToWordIndex, fullText,
      settings
    );
    for (const sc of subCaptions) {
      rawCaptions.push(sc);
    }
  }

  // ── STEP5: captionEndMode に応じて終了時刻を決定し、整形する ──────────────────
  const captions = rawCaptions.map((cap, idx) => {
    let { start, end, text, endWordIdx, isWordIndexFallback } = cap;
    const formattedText = formatCaptionText(text.trim(), charsPerLine, maxLines);

    // 次の字幕の開始時刻（重なり防止用）
    const nextStart = (idx < rawCaptions.length - 1) ? rawCaptions[idx + 1].start : Infinity;

    if (captionEndMode === 'speech_exact') {
      // ── speech_exact: 最後のword.end + endPaddingSec で終わらせる ──
      let speechEnd;
      if (endWordIdx !== undefined && endWordIdx >= 0 && endWordIdx < words.length) {
        // word index が有効：実際の発話終わりを使う
        speechEnd = words[endWordIdx].end + endPaddingSec;
      } else {
        // fallback: 文字数比で推定したendを使う（コード上のフォールバック）
        // fallback: word indexへ戻せなかったため文字数比推定値を使用
        speechEnd = end + endPaddingSec;
      }
      // 次の字幕に重ならないようにキャップ
      end = Math.min(speechEnd, nextStart - 0.01);
      // endがstartより前になるケースの安全処理
      if (end <= start) {
        end = Math.min(start + 0.1, nextStart - 0.01);
      }

    } else if (captionEndMode === 'min_duration') {
      // ── min_duration: 現在に近い方式。短すぎる字幕は伸ばす ──
      if (end - start < minDuration) {
        end = start + minDuration;
      }
      if (end - start > maxDuration) {
        end = start + maxDuration;
      }
      // 次の字幕に重ならないようにキャップ
      end = Math.min(end, nextStart - 0.01);
      if (end <= start) {
        end = start + 0.1;
      }

    } else if (captionEndMode === 'fixed') {
      // ── fixed: 開始から固定秒数だけ表示 ──
      end = start + fixedDisplaySec;
      // 次の字幕に重ならないようにキャップ
      end = Math.min(end, nextStart - 0.01);
      if (end <= start) {
        end = start + 0.1;
      }
    }

    return { start, end, text: formattedText };
  });

  // 重複補正（念のため）
  for (let i = 1; i < captions.length; i++) {
    if (captions[i - 1].end > captions[i].start) {
      captions[i - 1].end = captions[i].start - 0.01;
      if (captions[i - 1].end < captions[i - 1].start) {
        captions[i - 1].end = captions[i - 1].start + 0.1;
      }
    }
  }

  return captions;
}

// ============================================================
// 1つの「文」を、設定に従って1つ以上の字幕テキストに分割する
// 優先順位：句点→読点→意味切れ目→文字数（助詞先頭NG/末尾NG語チェック付き）
// word index を引き継いで、各字幕の endWordIdx を設定する
// ============================================================
function splitSentenceIntoCaptions(text, start, end, startWordIdx, endWordIdx, words, charToWordIndex, fullTextAll, settings) {
  const { charsPerLine, maxLines } = settings;
  const maxCaptionChars = charsPerLine * maxLines;

  // 文が収まるなら1字幕のまま返す
  if (text.length <= maxCaptionChars) {
    return [{ text, start, end, startWordIdx, endWordIdx, isWordIndexFallback: false }];
  }

  // 読点での自然な分割を試みる
  const commaBreakChars = ['、', '，', ','];
  const parts = splitAtNaturalBreaks(text, maxCaptionChars, commaBreakChars);

  // 得たパーツに時刻を割り当て、word index も割り当てる
  return assignTimesToPartsWithWordIndex(parts, text, start, end, startWordIdx, endWordIdx, words, charToWordIndex, fullTextAll);
}

// ============================================================
// 自然な区切り文字でテキストを分割する
// ============================================================
function splitAtNaturalBreaks(text, maxChars, breakChars) {
  const parts = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let breakPos = -1;

    // maxChars の範囲内で末尾から読点を探す
    for (let pos = maxChars - 1; pos >= Math.floor(maxChars * 0.4); pos--) {
      if (breakChars.includes(remaining[pos])) {
        const next = remaining.slice(pos + 1);
        if (next.length > 0 && !isNgHeadChar(next[0])) {
          breakPos = pos + 1;
          break;
        }
      }
    }

    if (breakPos > 0) {
      parts.push(remaining.slice(0, breakPos));
      remaining = remaining.slice(breakPos);
    } else {
      // 読点で分割できなかった → 文字数ベースで自然に切る
      const charParts = splitByCharsNatural(remaining, maxChars);
      parts.push(...charParts);
      remaining = '';
    }
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

// ============================================================
// 文字数ベースの分割（助詞先頭・末尾NG語を回避）
// ============================================================
function splitByCharsNatural(text, maxChars) {
  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      parts.push(remaining);
      break;
    }

    let breakPos = findNaturalBreakPos(remaining, maxChars);
    parts.push(remaining.slice(0, breakPos));
    remaining = remaining.slice(breakPos);
  }

  return parts;
}

// ============================================================
// 文字列の自然な切り位置を見つける（助詞先頭・末尾NG語を回避）
// ============================================================
function findNaturalBreakPos(text, maxChars) {
  const searchForward = Math.min(text.length, Math.floor(maxChars * 1.3));
  const searchBack = Math.floor(maxChars * 0.5);

  for (let pos = maxChars; pos >= searchBack; pos--) {
    if (pos <= 0) break;
    const nextChar = text[pos] || '';
    const prevChar = text[pos - 1] || '';

    if ('。！？、，!?,'.includes(prevChar)) {
      if (!isNgHeadChar(nextChar)) {
        return pos;
      }
    }
  }

  let pos = maxChars;

  while (pos < searchForward && pos < text.length) {
    const nextChar = text[pos] || '';
    if (!isNgHeadChar(nextChar)) {
      break;
    }
    pos++;
  }

  if (pos >= searchForward || isNgHeadChar(text[pos] || '')) {
    pos = maxChars;
    while (pos > searchBack) {
      const nextChar = text[pos] || '';
      if (!isNgHeadChar(nextChar)) {
        break;
      }
      pos--;
    }
  }

  const slice = text.slice(0, pos);
  if (isNgTailWord(slice)) {
    pos = Math.min(pos + 1, text.length);
  }

  return Math.max(1, pos);
}

// ============================================================
// 字幕先頭になってはいけない文字かどうかを判定する
// ============================================================
function isNgHeadChar(ch) {
  if (!ch) return false;
  const ngChars = new Set(['の', 'に', 'を', 'が', 'は', 'も', 'と', 'で', 'へ', 'や', 'な', 'ね', 'よ', 'か', 'わ', 'ぞ', 'ぜ', 'さ', 'し']);
  return ngChars.has(ch);
}

// ============================================================
// 字幕末尾がNG語になっていないか確認する
// ============================================================
function isNgTailWord(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const ngTails = ['次', 'い', 'また', 'この', 'その', 'あの', 'どの', 'こう', 'そう', 'ああ', 'どう'];
  for (const ng of ngTails) {
    if (trimmed.endsWith(ng)) return true;
  }
  return false;
}

// ============================================================
// 分割したパーツに開始・終了時刻とword indexを割り当てる
//
// 文字位置 → charToWordIndex → words[idx].end を使って
// 各パーツの endWordIdx を決定する。
// charToWordIndex が fullText 全体のマップのため、
// 分割されたパーツのテキストを fullTextAll から探して位置を特定する。
// ============================================================
function assignTimesToPartsWithWordIndex(parts, originalText, start, end, startWordIdx, endWordIdx, words, charToWordIndex, fullTextAll) {
  const totalDuration = end - start;
  const totalChars = originalText.length;
  const result = [];
  let currentTime = start;

  // originalText が fullTextAll のどこにあるかを特定する
  // （sentenceWithTime の startCharIdx に相当する全体オフセット）
  // words から start 時刻で逆引きしてオフセットを求める
  let globalOffset = -1;
  for (let wi = 0; wi < words.length; wi++) {
    if (words[wi] && Math.abs(words[wi].start - words[startWordIdx].start) < 0.001) {
      // startWordIdx の word が fullTextAll 上で占める位置を計算
      let charPos = 0;
      for (let i = 0; i < startWordIdx; i++) {
        charPos += words[i].word.length;
      }
      globalOffset = charPos;
      break;
    }
  }

  // globalOffset が -1 の場合は fallback（文字数比のみ）
  const canUseWordIndex = (globalOffset >= 0 && charToWordIndex && charToWordIndex.length > 0);

  let partCharOffset = 0; // originalText 内での文字位置

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const ratio = part.length / totalChars;
    const duration = totalDuration * ratio;
    const partStart = currentTime;
    const partEnd = i === parts.length - 1 ? end : currentTime + duration;

    // このパーツの最後の文字が fullTextAll 上でどの word に対応するか
    let partEndWordIdx = endWordIdx;        // デフォルトは親文の endWordIdx
    let isWordIndexFallback = false;

    if (canUseWordIndex) {
      // partCharOffset + part.length - 1 = このパーツの最後の文字の originalText 内での位置
      const lastCharInOriginal = partCharOffset + part.length - 1;
      const globalCharIdx = globalOffset + lastCharInOriginal;

      if (globalCharIdx >= 0 && globalCharIdx < charToWordIndex.length && charToWordIndex[globalCharIdx] !== undefined) {
        partEndWordIdx = charToWordIndex[globalCharIdx];
      } else {
        // fallback: charToWordIndex の範囲外
        // fallback: globalCharIdx が charToWordIndex の範囲外のため文字数比推定値を使用
        isWordIndexFallback = true;
      }
    } else {
      // fallback: globalOffset が取得できなかったため文字数比推定値を使用
      isWordIndexFallback = true;
    }

    result.push({
      text: part,
      start: partStart,
      end: partEnd,
      startWordIdx: i === 0 ? startWordIdx : undefined,
      endWordIdx: partEndWordIdx,
      isWordIndexFallback,
    });

    partCharOffset += part.length;
    currentTime = partEnd;
  }

  return result;
}

// ============================================================
// SRT生成ロジック：segments fallback
// ============================================================
function buildCaptionsFromSegments(segments, settings) {
  const { charsPerLine, maxLines, minDuration, maxDuration, captionEndMode, endPaddingSec, fixedDisplaySec } = settings;
  const maxCaptionChars = charsPerLine * maxLines;
  const captions = [];

  for (const seg of segments) {
    const segText = seg.text.trim();

    if (!segText) continue;

    const sentenceBreakChars = new Set(['。', '！', '？', '!', '?']);
    const sentences = [];
    let sentStart = 0;

    for (let ci = 0; ci < segText.length; ci++) {
      if (sentenceBreakChars.has(segText[ci])) {
        const sentText = segText.slice(sentStart, ci + 1).trim();
        if (sentText.length > 0) sentences.push(sentText);
        sentStart = ci + 1;
      }
    }
    if (sentStart < segText.length) {
      const sentText = segText.slice(sentStart).trim();
      if (sentText.length > 0) sentences.push(sentText);
    }
    if (sentences.length === 0) sentences.push(segText);

    const segDuration = seg.end - seg.start;

    for (const sentText of sentences) {
      const subParts = sentText.length <= maxCaptionChars
        ? [sentText]
        : splitByCharsNatural(sentText, maxCaptionChars);

      for (const part of subParts) {
        let start = seg.start;
        // segments fallback では word.end が取れないため、
        // captionEndMode に関わらず現行ロジックに近い処理を使う
        let end = seg.end;
        if (captionEndMode === 'fixed') {
          end = start + fixedDisplaySec;
        } else if (captionEndMode === 'min_duration') {
          if (end - start < minDuration) end = start + minDuration;
          if (end - start > maxDuration) end = start + maxDuration;
        } else {
          // speech_exact でも segments の場合は seg.end + endPaddingSec を使う（word がないため）
          end = seg.end + endPaddingSec;
        }
        const text = formatCaptionText(part.trim(), charsPerLine, maxLines);
        captions.push({ start, end, text });
      }
    }
  }

  // 重複補正
  for (let i = 1; i < captions.length; i++) {
    if (captions[i - 1].end > captions[i].start) {
      captions[i - 1].end = captions[i].start - 0.01;
    }
  }

  return captions;
}

// ============================================================
// 字幕テキストを行数・文字数で整形する（改行挿入）
// ============================================================
function formatCaptionText(text, charsPerLine, maxLines) {
  if (maxLines === 1) {
    return text;
  }

  if (text.length <= charsPerLine) {
    return text;
  }

  const targetBreak = Math.ceil(text.length / 2);
  const naturalBreakAfter = ['。', '！', '？', '、', '，', '!', '?', ','];

  let breakPos = targetBreak;
  const searchRange = Math.floor(charsPerLine / 2);

  for (let d = 0; d <= searchRange; d++) {
    for (const delta of [d, -d]) {
      const pos = targetBreak + delta;
      if (pos > 0 && pos < text.length) {
        const prevChar = text[pos - 1];
        const nextChar = text[pos] || '';
        if (naturalBreakAfter.includes(prevChar) && !isNgHeadChar(nextChar)) {
          breakPos = pos;
          break;
        }
      }
    }
    if (breakPos !== targetBreak) break;
  }

  if (breakPos === targetBreak) {
    let pos = targetBreak;
    while (pos > 1 && isNgHeadChar(text[pos] || '')) {
      pos--;
    }
    if (isNgHeadChar(text[pos] || '')) {
      pos = targetBreak;
      while (pos < text.length - 1 && isNgHeadChar(text[pos] || '')) {
        pos++;
      }
    }
    breakPos = pos;
  }

  const line1 = text.slice(0, breakPos);
  const line2 = text.slice(breakPos);

  if (line1.length > charsPerLine) {
    const saferBreak = findNaturalBreakPos(text, charsPerLine);
    return text.slice(0, saferBreak) + '\n' + text.slice(saferBreak);
  }

  return line1 + '\n' + line2;
}

// ============================================================
// SRT文字列を組み立てる
// ============================================================
function buildSrtString(captions) {
  return captions.map((cap, idx) => {
    const num = idx + 1;
    const startStr = secondsToSrtTime(cap.start);
    const endStr = secondsToSrtTime(cap.end);
    return `${num}\n${startStr} --> ${endStr}\n${cap.text}\n`;
  }).join('\n');
}

// ============================================================
// 秒数 → SRT時間形式（HH:MM:SS,mmm）
// ============================================================
function secondsToSrtTime(totalSeconds) {
  const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
  const hh = String(Math.floor(totalMs / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, '0');
  const mmm = String(totalMs % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

// ============================================================
// 通常文字起こし用タイムコード（00;00;00;00形式・既存互換）
// ============================================================
function secondsToTimecode(totalSeconds) {
  const sec = Math.floor(totalSeconds);
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${hh};${mm};${ss};00`;
}

// ============================================================
// 未定義ルートへのフォールバック
// ============================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'エンドポイントが見つかりません。',
    availableEndpoints: ['GET /api/health', 'POST /api/transcribe', 'POST /api/generate-srt'],
  });
});

// ============================================================
// エラーハンドラ
// ============================================================
app.use((err, req, res, next) => {
  console.error('予期しないエラー:', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'ファイルサイズが大きすぎます。500MB以下のファイルを使用してください。',
    });
  }

  res.status(500).json({
    success: false,
    error: 'サーバー内部エラーが発生しました。',
    details: err.message,
  });
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Transcriber backend 起動中: http://localhost:${PORT}`);
  console.log(`   ヘルスチェック: http://localhost:${PORT}/api/health`);
  console.log(`   通常文字起こし: POST http://localhost:${PORT}/api/transcribe`);
  console.log(`   SRT生成:        POST http://localhost:${PORT}/api/generate-srt`);
});
