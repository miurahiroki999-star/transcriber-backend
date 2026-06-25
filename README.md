# AI文字起こし バックエンド - Renderデプロイ手順

このバックエンドは **Render** 上で動きます。
Node.js + Express + ffmpeg + OpenAI API で構成されており、
長尺音声をサーバー側で自動分割・文字起こしします。

---

## このバックエンドがやること

1. フロントから音声ファイルを受け取る
2. **サーバー側で ffmpeg を使って音声を指定分数ごとに分割する**
3. 分割した音声を順番に OpenAI API に送って文字起こしする
4. タイムコードを付けて結合し、フロントへ返す

※ ブラウザ側では何も分割しません。サーバー側だけで完結します。

---

## ファイル構成

```
backend/
├── server.js          ← メインのサーバーコード
├── package.json       ← 使用するライブラリの定義
├── .env.example       ← 環境変数のサンプル（.envは作らない）
├── render.yaml        ← Renderの設定ファイル（オプション）
└── README.md          ← この手順書
```

---

## ステップ1：GitHubにバックエンドリポジトリを作る

1. ブラウザで [https://github.com](https://github.com) を開く
2. ログインして、右上の「**＋**」→「**New repository**」をクリック
3. Repository name に `transcriber-backend` と入力
4. 「**Private**」を選択（APIキーを使う設定のため）
5. 「**Create repository**」をクリック
6. 次の画面で「**uploading an existing file**」をクリック
7. 以下の4ファイルをドラッグ＆ドロップ：
   - `server.js`
   - `package.json`
   - `.env.example`
   - `render.yaml`
8. 「**Commit changes**」をクリック

---

## ステップ2：RenderでNew Web Serviceを作る

1. ブラウザで [https://render.com](https://render.com) を開く
2. アカウントを作成（GitHubアカウントでログイン可）
3. ダッシュボードで「**New +**」→「**Web Service**」をクリック
4. 「**Connect a repository**」でGitHubアカウントを連携
5. `transcriber-backend` リポジトリを選択して「**Connect**」
6. 設定画面で以下を入力：

| 項目 | 入力内容 |
|------|---------|
| **Name** | transcriber-backend（任意） |
| **Region** | Oregon (US West) または Singapore |
| **Branch** | main |
| **Runtime** | Node |
| **Build Command** | `apt-get install -y ffmpeg && npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free（無料プラン） |

> ⚠️ **Build Command が最重要です。**
> `apt-get install -y ffmpeg && npm install` と正確に入力してください。
> これで ffmpeg がインストールされます。

---

## ステップ3：OPENAI_API_KEY を設定する

1. 同じRenderの設定画面の下の方に「**Environment Variables**」セクションがある
2. 「**Add Environment Variable**」をクリック
3. 以下を入力：
   - **Key**: `OPENAI_API_KEY`
   - **Value**: `sk-proj-xxxxxxxxxxxx`（OpenAIのAPIキー）
4. 「**Create Web Service**」をクリック（または「Save」）

### OpenAI APIキーの取得方法

1. [https://platform.openai.com](https://platform.openai.com) にログイン
2. 左メニュー「**API Keys**」→「**Create new secret key**」
3. キー（`sk-proj-...`）をコピー
4. ⚠️ キーは一度しか表示されないのでメモしておくこと

---

## ステップ4：デプロイ完了の確認

1. Renderのダッシュボードでデプロイが始まる（5〜10分かかる場合あり）
2. ログに `✅ Transcriber backend 起動中` と表示されれば成功
3. 画面上部に表示される **デプロイURL** をメモする
   - 例: `https://transcriber-backend-xxxx.onrender.com`

---

## ステップ5：ヘルスチェックで動作確認

デプロイURLが分かったら、ブラウザのアドレスバーに以下を入力：

```
https://transcriber-backend-xxxx.onrender.com/api/health
```

以下のようなJSONが表示されれば **バックエンドは正常に動いています**：

```json
{
  "ok": true,
  "message": "Transcriber backend is running",
  "time": "2025-01-01T00:00:00.000Z"
}
```

---

## ステップ6：フロントエンドにRenderのURLを設定する

`frontend/index.html` を開き、**ファイルの上部** にある以下の行を探します：

```javascript
const API_URL = "https://ここにRenderのURLを入れる.onrender.com/api/transcribe";
```

↓ 自分のRenderのURLに書き換えます：

```javascript
const API_URL = "https://transcriber-backend-xxxx.onrender.com/api/transcribe";
```

書き換えたら保存して、GitHubにアップロードし直してください（Netlifyが自動更新されます）。

---

## ステップ7：Netlifyへの反映方法

`index.html` を更新したら：

1. GitHubの `ai-transcribe` リポジトリを開く
2. `index.html` を選択 → 右上の「鉛筆マーク（Edit）」をクリック
3. `API_URL` の行を書き換える
4. 「**Commit changes**」をクリック
5. Netlifyが自動的に再デプロイします（通常1〜2分）

または、更新した `index.html` をドラッグ＆ドロップで上書きアップロードしてもOKです。

---

## テスト手順

### ステップ1：1分程度のmp3でテスト

1. 1分以内のmp3ファイルを用意する
2. フロントの画面でファイルを選択
3. モデル「gpt-4o-mini-transcribe」、分割単位「10分」で実行
4. 結果テキストが表示されればOK

### ステップ2：10分程度のmp3でテスト

1. 10分程度のmp3を用意
2. 分割単位「10分」（チャンクが1〜2個になる）で実行
3. タイムコード `00;00;00;00` が付いた結果が出ることを確認

### ステップ3：30分程度のmp3でテスト

1. 30分程度のmp3を用意
2. 分割単位「10分」で実行（3チャンクになる）
3. チャンク2の開始タイムコードが `00;10;00;00` になっていることを確認
4. チャンク3の開始タイムコードが `00;20;00;00` になっていることを確認

### ステップ4：失敗したら5分に変更

10分で失敗する場合は分割単位を「5分」に変更して再試行

### ステップ5：gpt-4o-mini-transcribeで通常文字起こし

日常的な文字起こしはこのモデルで十分。コスト最安。

### ステップ6：whisper-1でタイムコード確認

タイムコード精度が重要な場合は whisper-1 を使用。
セグメント単位のタイムスタンプが取得できる。

---

## 想定エラーと対処

| エラー・症状 | 原因 | 対処 |
|---|---|---|
| ヘルスチェックで画面が白いまま | まだデプロイ中 | 5〜10分待って再アクセス |
| `{"ok":true}` が出ない | Build Command のミス | `apt-get install -y ffmpeg && npm install` を確認 |
| 「OPENAI_API_KEY が設定されていません」 | 環境変数未設定 | Render > Environment > 変数を確認 |
| 「ffmpegで音声の分割に失敗しました」 | 音声ファイルが壊れている | 別のmp3/m4aで試す |
| 「OpenAI APIエラー (401)」 | APIキーが無効 | OpenAIで新しいキーを作成 |
| 「OpenAI APIエラー (429)」 | API制限超過 | しばらく待つ、またはOpenAIの料金プランを確認 |
| Renderが15分で止まる | 無料プランはアイドルで停止 | 初回アクセス時に30秒〜1分かかるが正常。または有料プランへ |
| 処理が途中で終わる | 音声が長すぎ / ffmpegのタイムアウト | 10分を5分に変更して再試行 |

---

## Renderの無料プランについて

- 無料プランはアクセスがないと **15分後に自動停止**します
- 次にアクセスしたとき **30秒〜1分かかって再起動**します
- 処理中に止まることはありません（起動さえすれば動き続けます）
- 長尺音声（60分など）の処理は有料プランの方が安定します

---

## 検品チェックリスト

- [ ] `https://xxx.onrender.com/api/health` で `{"ok":true}` が返る
- [ ] 1分音声でテストして結果が出る
- [ ] タイムコード `00;00;00;00` が先頭に付いている
- [ ] 30分音声でテストして複数チャンクの結果が出る
- [ ] 2チャンク目のタイムコードが `00;10;00;00` になっている（10分設定の場合）
- [ ] 「全文コピー」が動く
- [ ] 「txtで保存」でファイルがダウンロードできる
- [ ] メモ帳で開いて文字化けしていない
