// ============================================================
// AI文字起こし + Premiere SRTメーカー バックエンド - server.js
// Render (Node.js + Express + ffmpeg-static + OpenAI API)
//
// エンドポイント：
//   GET  /api/health         ヘルスチェック
//   POST /api/transcribe     通常文字起こし（既存・変更なし）
//   POST /api/generate-srt   Premiere Pro用SRT生成（新規追加）
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

  const maxCaptionChars = charsPerLine * maxLines;

  const captionSettings = { chunkMinutes, charsPerLine, maxLines, minDuration, maxDuration, captionMode, maxCaptionChars };

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
  // word timestamps または segments を収集
  const allWords = [];   // { word, start, end } の配列（絶対時刻）
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
    // ── word timestamps からSRT生成 ──
    timingSource = 'word';
    captions = buildCaptionsFromWords(allWords, captionSettings);
  } else {
    // ── segments fallback ──
    timingSource = 'segment';
    captions = buildCaptionsFromSegments(allSegments, captionSettings);
  }

  const srt = buildSrtString(captions);

  cleanup();

  const completedChunks = chunkResults.filter(c => c.status === 'completed').length;

  console.log(`=== SRT生成完了 ===`);
  console.log(`字幕数: ${captions.length}, タイミング源: ${timingSource}`);

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
    ...(timingSource === 'segment'
      ? { warning: 'word timestamps が取得できなかったため、segments と文字数比でSRTを生成しました。タイミングは目安を含みます。' }
      : {}),
  });

});

// ============================================================
// SRT生成ロジック：word timestamps から字幕を組み立てる
// ============================================================
function buildCaptionsFromWords(words, settings) {
  const { charsPerLine, maxLines, minDuration, maxDuration, captionMode } = settings;
  const maxCaptionChars = charsPerLine * maxLines;

  // モード別：句読点で切りやすい文字セット
  const strongBreaks = new Set(['。', '！', '？', '!', '?']);
  const weakBreaks = new Set(['、', '，', ',']);

  const captions = [];
  let currentWords = [];
  let currentText = '';
  let captionStart = null;

  const flush = (endTime) => {
    if (currentWords.length === 0) return;
    const start = captionStart;
    let end = endTime;

    // 最短表示秒数を確保
    if (end - start < minDuration) {
      end = start + minDuration;
    }
    // 最長表示秒数を超えない
    if (end - start > maxDuration) {
      end = start + maxDuration;
    }

    const text = formatCaptionText(currentText.trim(), charsPerLine, maxLines);
    captions.push({ start, end, text });

    currentWords = [];
    currentText = '';
    captionStart = null;
  };

  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    const word = w.word;

    if (captionStart === null) {
      captionStart = w.start;
    }

    const nextText = currentText + word;
    const nextCharCount = nextText.replace(/\s/g, '').length;

    // 時間経過チェック（最長表示秒数）
    const duration = w.end - captionStart;

    // 次の単語との無音ギャップ
    const nextWord = words[wi + 1];
    const gap = nextWord ? (nextWord.start - w.end) : 0;

    // モード別の切り方
    let shouldBreak = false;

    // 文字数超過 → 必ず切る
    if (nextCharCount > maxCaptionChars) {
      shouldBreak = true;
    }

    // 時間超過 → 必ず切る
    else if (duration >= maxDuration) {
      shouldBreak = true;
    }

    // 句点・感嘆符・疑問符の後 → 切りやすい
    else if (strongBreaks.has(word.slice(-1))) {
      if (captionMode === 'short') {
        shouldBreak = true;
      } else if (captionMode === 'context' || captionMode === 'seminar') {
        // 文字数が一定以上ならここで切る
        const charCount = nextCharCount;
        shouldBreak = charCount >= Math.floor(maxCaptionChars * 0.4);
      }
    }

    // 読点の後 → モードによって切る
    else if (weakBreaks.has(word.slice(-1))) {
      if (captionMode === 'short') {
        shouldBreak = nextCharCount >= Math.floor(maxCaptionChars * 0.5);
      } else if (captionMode === 'context') {
        shouldBreak = nextCharCount >= Math.floor(maxCaptionChars * 0.7);
      }
      // seminarは読点では切らない
    }

    // 無音ギャップ（0.5秒以上）→ 切りやすい
    else if (gap >= 0.5) {
      if (captionMode === 'short') {
        shouldBreak = nextCharCount >= Math.floor(maxCaptionChars * 0.3);
      } else {
        shouldBreak = nextCharCount >= Math.floor(maxCaptionChars * 0.5);
      }
    }

    currentText += word;
    currentWords.push(w);

    if (shouldBreak || wi === words.length - 1) {
      // 最短秒数チェック：短すぎる場合は次と結合を試みる
      const tentativeDuration = w.end - captionStart;

      if (shouldBreak && tentativeDuration < minDuration && wi < words.length - 1) {
        // まだ結合できる場合はここでは切らない（次のループで再判断）
        // ただし文字数超過・時間超過の場合は強制的に切る
        const mustBreak = nextCharCount > maxCaptionChars || duration >= maxDuration;
        if (!mustBreak) {
          // 切らずに続ける
        } else {
          flush(w.end);
        }
      } else {
        flush(w.end);
      }
    }
  }

  // 末尾に残った場合
  if (currentWords.length > 0 && words.length > 0) {
    const lastWord = words[words.length - 1];
    flush(lastWord.end);
  }

  // 字幕間の時間が重ならないよう補正
  for (let i = 1; i < captions.length; i++) {
    if (captions[i - 1].end > captions[i].start) {
      captions[i - 1].end = captions[i].start - 0.01;
      // マイナスにならないよう
      if (captions[i - 1].end < captions[i - 1].start) {
        captions[i - 1].end = captions[i - 1].start + 0.1;
      }
    }
  }

  return captions;
}

// ============================================================
// SRT生成ロジック：segments fallback
// ============================================================
function buildCaptionsFromSegments(segments, settings) {
  const { charsPerLine, maxLines, minDuration, maxDuration } = settings;
  const maxCaptionChars = charsPerLine * maxLines;
  const captions = [];

  for (const seg of segments) {
    const segText = seg.text.trim();
    const segDuration = seg.end - seg.start;

    if (!segText) continue;

    // segment が maxCaptionChars 以下なら1字幕
    if (segText.length <= maxCaptionChars) {
      let start = seg.start;
      let end = seg.end;
      if (end - start < minDuration) end = start + minDuration;
      if (end - start > maxDuration) end = start + maxDuration;
      const text = formatCaptionText(segText, charsPerLine, maxLines);
      captions.push({ start, end, text });
    } else {
      // 長いsegmentを文字数比で分割
      const chunks = splitTextByChars(segText, maxCaptionChars);
      const totalChars = segText.length;
      let currentTime = seg.start;

      for (const chunk of chunks) {
        const ratio = chunk.length / totalChars;
        const duration = Math.max(minDuration, Math.min(maxDuration, segDuration * ratio));
        const start = currentTime;
        const end = start + duration;
        const text = formatCaptionText(chunk, charsPerLine, maxLines);
        captions.push({ start, end: Math.min(end, seg.end), text });
        currentTime = end;
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
// テキストを指定文字数で自然な位置で分割する
// ============================================================
function splitTextByChars(text, maxChars) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // maxChars の範囲内で自然な区切りを探す
    let breakPos = maxChars;

    // 句点・読点・助詞後などで自然に切る
    const naturalBreaks = ['。', '！', '？', '、', '，'];
    for (let pos = maxChars; pos >= Math.floor(maxChars * 0.5); pos--) {
      if (naturalBreaks.includes(remaining[pos - 1])) {
        breakPos = pos;
        break;
      }
    }

    chunks.push(remaining.slice(0, breakPos));
    remaining = remaining.slice(breakPos);
  }

  return chunks;
}

// ============================================================
// 字幕テキストを行数・文字数で整形する
// ============================================================
function formatCaptionText(text, charsPerLine, maxLines) {
  if (maxLines === 1) {
    return text;
  }

  // 2行の場合、自然な位置で改行
  if (text.length <= charsPerLine) {
    return text;
  }

  // 自然な改行位置を探す（読点・句点・助詞・中間付近）
  const targetBreak = Math.ceil(text.length / 2);
  const naturalBreakChars = ['。', '！', '？', '、', '，', 'は', 'が', 'を', 'に', 'で', 'も', 'と', 'の'];

  let breakPos = targetBreak;

  // targetBreak の周辺 ±10文字で自然な区切りを探す
  const searchRange = 10;
  for (let d = 0; d <= searchRange; d++) {
    for (const delta of [d, -d]) {
      const pos = targetBreak + delta;
      if (pos > 0 && pos < text.length) {
        const c = text[pos - 1];
        if (naturalBreakChars.includes(c)) {
          breakPos = pos;
          break;
        }
      }
    }
    if (breakPos !== targetBreak) break;
  }

  const line1 = text.slice(0, breakPos);
  const line2 = text.slice(breakPos);

  // 各行がcharsPerLineを超える場合は文字数で強制分割（2行まで）
  if (line1.length > charsPerLine) {
    return text.slice(0, charsPerLine) + '\n' + text.slice(charsPerLine, charsPerLine * 2);
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
  // SRT形式は HH:MM:SS,mmm。mmm が 1000 になるとPremiereで読み込み不具合の原因になるため、ミリ秒総数から安全に計算する。
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
