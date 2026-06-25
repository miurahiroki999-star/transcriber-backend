// ============================================================
// AI文字起こし バックエンド - server.js
// Render (Node.js + Express + ffmpeg + OpenAI API)
//
// 役割：
//   フロントから音声ファイルを受け取り、ffmpegで分割し、
//   OpenAI Transcriptions API で文字起こし、結合して返す。
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
// CORS設定（どのNetlifyドメインからでも受け付ける）
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ============================================================
// ファイルアップロード設定（multer）
// 一時ファイルは /tmp に保存
// ============================================================
const upload = multer({
  dest: '/tmp/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB上限（長尺音声対応）
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'audio/mp4', 'audio/m4a', 'audio/x-m4a',
      'audio/mpeg', 'audio/mp3',
      'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/ogg', 'audio/webm',
      'video/mp4',
    ];
    // mimetypeが不明でもとりあえず受け付ける（拡張子で判断するため）
    cb(null, true);
  },
});

// ============================================================
// ヘルスチェック
// GET /api/health → バックエンドが動いているか確認用
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Transcriber backend is running',
    time: new Date().toISOString(),
  });
});

// ============================================================
// メイン：文字起こしエンドポイント
// POST /api/transcribe
// ============================================================
app.post('/api/transcribe', upload.single('audioFile'), async (req, res) => {

  const uploadedPath = req.file ? req.file.path : null;
  const chunkPaths = [];

  // 終了時に一時ファイルをすべて削除するクリーンアップ関数
  const cleanup = () => {
    try {
      if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      chunkPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
    } catch (e) {
      console.error('クリーンアップエラー:', e.message);
    }
  };

  // エラーレスポンス共通関数
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

  // ── (3) パラメータ取得 ──────────────────────────────────
  const allowedModels = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
  const model = allowedModels.includes(req.body.model) ? req.body.model : 'gpt-4o-mini-transcribe';

  const chunkMinutesRaw = parseInt(req.body.chunkMinutes, 10);
  const chunkMinutes = [5, 10, 15].includes(chunkMinutesRaw) ? chunkMinutesRaw : 10;
  const chunkSeconds = chunkMinutes * 60;

  console.log(`=== 文字起こし開始 ===`);
  console.log(`モデル: ${model}`);
  console.log(`分割単位: ${chunkMinutes}分（${chunkSeconds}秒）`);
  console.log(`ファイルサイズ: ${(req.file.size / 1024 / 1024).toFixed(1)}MB`);

  // ── (4) ffmpegで音声を分割 ──────────────────────────────────
  // 分割後ファイルのプレフィックス（/tmp/chunk_TIMESTAMP_）
  const timestamp = Date.now();
  const chunkPrefix = `/tmp/chunk_${timestamp}_`;
  const chunkPattern = `${chunkPrefix}%03d.mp3`;

  const ffmpegCmd = [
    `"${ffmpegPath}"`,
    '-y',                         // 上書き確認なし
    `-i "${uploadedPath}"`,       // 入力ファイル
    '-ac 1',                      // モノラル
    '-ar 16000',                  // 16kHz
    '-b:a 32k',                   // 32kbps（文字起こし用に軽量化）
    `-f segment`,                 // セグメント分割モード
    `-segment_time ${chunkSeconds}`, // 分割秒数
    `-reset_timestamps 1`,        // チャンクの時間を0リセット
    `"${chunkPattern}"`,          // 出力パターン
  ].join(' ');

  console.log('ffmpegコマンド実行中...');

  try {
    await execAsync(ffmpegCmd, { timeout: 600000 }); // 最大10分
  } catch (err) {
    console.error('ffmpegエラー:', err.message);
    return sendError(500, 'ffmpegで音声の分割に失敗しました。音声ファイルの形式を確認してください。', err.message);
  }

  // 生成されたチャンクファイルを収集
  const tmpFiles = fs.readdirSync('/tmp').filter(f => f.startsWith(`chunk_${timestamp}_`) && f.endsWith('.mp3'));
  tmpFiles.sort(); // 000, 001, 002... の順にソート
  tmpFiles.forEach(f => chunkPaths.push(path.join('/tmp', f)));

  if (chunkPaths.length === 0) {
    return sendError(500, 'ffmpegで音声を分割できませんでした。音声ファイルが空か破損している可能性があります。');
  }

  console.log(`チャンク数: ${chunkPaths.length}`);

  // ── (5) 各チャンクをOpenAI APIで文字起こし ──────────────────────────────────
  const chunkResults = [];
  let fullText = '';

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

      // whisper-1 は verbose_json でセグメントタイムスタンプを取得
      if (model === 'whisper-1') {
        formData.append('response_format', 'verbose_json');
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

      // タイムコード付きテキストを構築
      let chunkText = '';

      if (model === 'whisper-1' && result.segments && result.segments.length > 0) {
        // whisper-1: セグメントごとの正確なタイムスタンプを使用
        for (const seg of result.segments) {
          const absStart = startSec + seg.start;
          const tc = secondsToTimecode(absStart);
          chunkText += `${tc}\n${seg.text.trim()}\n\n`;
        }
      } else {
        // gpt-4o系: チャンク開始時刻のみ付与（推定）
        const tc = secondsToTimecode(startSec);
        chunkText = `${tc}\n${(result.text || '').trim()}\n\n`;
      }

      fullText += chunkText;

      chunkResults.push({
        index: chunkIndex,
        startSec,
        status: 'completed',
        text: (result.text || '').substring(0, 100) + '...', // ログ用に先頭100文字
      });

      console.log(`チャンク ${chunkIndex} 完了`);

    } catch (err) {
      console.error(`チャンク ${chunkIndex} 失敗:`, err.message);
      chunkResults.push({
        index: chunkIndex,
        startSec,
        status: 'failed',
        error: err.message,
      });
      // 失敗したチャンクはスキップして継続
      const tc = secondsToTimecode(startSec);
      fullText += `${tc}\n[チャンク${chunkIndex}の文字起こしに失敗しました: ${err.message}]\n\n`;
    }
  }

  // ── (6) 結果を返す ──────────────────────────────────
  cleanup();

  const failedCount = chunkResults.filter(c => c.status === 'failed').length;

  console.log(`=== 完了 ===`);
  console.log(`成功: ${chunkResults.length - failedCount} / ${chunkResults.length}`);

  return res.json({
    success: true,
    text: fullText.trim(),
    model,
    totalChunks: chunkPaths.length,
    completedChunks: chunkResults.length - failedCount,
    failedChunks: failedCount,
    chunks: chunkResults,
  });

});

// ============================================================
// タイムコード変換ユーティリティ
// 秒数 → 00;00;00;00 形式
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
    availableEndpoints: ['GET /api/health', 'POST /api/transcribe'],
  });
});

// ============================================================
// エラーハンドラ（予期しないエラー）
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
});
