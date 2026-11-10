# FlareMetal PDF 編輯器

在瀏覽器裡塗改 PDF、JPG、PNG 的純前端工具。檔案只在您的裝置上處理，**不會上傳到任何伺服器**。部署目標是 [pdf.flaremetal.com](https://pdf.flaremetal.com)。

## 兩種匯出

| 模式 | 行為 | 適合 |
| --- | --- | --- |
| 安全匯出（無法還原） | 每頁以 150 / 200 / 300 DPI 畫成圖片，把矩形和筆刷畫進像素，再組成新 PDF。文字、向量、圖層、標題與作者等 metadata 都不會保留。旋轉後的方向已經烘進圖片。 | 要隱藏機密 |
| 一般匯出（只有視覺遮蓋） | 保留原本的 PDF，在上面畫實心矩形和同樣顏色、粗細的筆刷線條，並把頁面 `/Rotate` 設成旋轉後的方向。底下的文字和圖片仍然存在，可以複製或還原。 | 只是做記號，**不能用來藏機密** |

圖片還可以另外匯出成 PNG（遮蓋已併入像素）。輸出檔名是原檔名加上 `_redacted`。

安全匯出的頁面是 JPEG 圖片，文字無法選取或搜尋，檔案可能變大。超過瀏覽器畫布上限的頁面會自動降低解析度，並在完成時提示。

## 筆刷、旋轉、列印

- 工具列可在矩形、筆刷、橡皮擦、平移之間切換。筆刷粗細約 4–80 px，顏色和矩形共用。橡皮擦只擦筆刷，不會改到原始 PDF。
- 每一筆、每一次擦除、每一次旋轉都是一步，可用 Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y）復原。
- 主畫面和每一頁縮圖都有向左、向右轉 90°。工具列上的旋轉是全部頁面一起轉。已畫的矩形和筆刷留在 PDF 使用者座標，會跟著頁面轉。
- 列印（工具列按鈕或 Ctrl/Cmd+P）會先選安全模式或一般模式，預設安全模式。一般瀏覽器用隱藏的 PDF 直接列印；iOS Safari 會改開新分頁。

## 本機確認旋轉和筆刷對得準

1. `npm run dev`，打開 PDF。
2. 按主畫面的「向右轉 90°」。
3. 選筆刷，在頁面上畫一筆。
4. 一般匯出：用預覽軟體打開，線條應蓋在你畫的位置，頁面方向是轉過的。
5. 安全匯出：同一筆應出現在同一位置，但文字無法選取，檔案資訊裡的標題與作者是空的。

## 本機開發

需要 Node.js 22。

```bash
npm install
npm run dev
```

瀏覽器打開終端機顯示的網址（預設 http://127.0.0.1:5173）。把 PDF 或圖片拖進去即可。

```bash
npm run typecheck
npm run build
npm run preview
```

`npm run build` 會把 pdf.js 的字型、CMap 與 wasm 複製到 `dist/pdfjs/`，正式環境不依賴外網。

## 部署到 Cloudflare

這個專案是 **Workers 靜態資源**，沒有後端。`wrangler.jsonc` 的 `assets.directory` 指向 `dist`。

```bash
npx wrangler login
npm run deploy
```

`npm run deploy` 會先建置再執行 `wrangler deploy`。完成後 Cloudflare 會給一個 `*.workers.dev` 網址，先用它確認頁面開得起來。

### 綁定 pdf.flaremetal.com

這些要在 Cloudflare 後台手動做：

1. `flaremetal.com` 的 DNS 必須在**同一個** Cloudflare 帳號。
2. 左側進入 **Workers 和 Pages**（Workers & Pages）。
3. 打開 Worker **flaremetal-pdf**。
4. **設定 Settings → 網域和路由 Domains & Routes → 新增 Add → 自訂網域 Custom domain**。
5. 輸入 `pdf.flaremetal.com` 並確認。
6. Cloudflare 會自動建立 DNS 紀錄並簽憑證。憑證狀態變成有效後即可開啟。

不需要設定 R2、KV、或任何上傳用的 API。網站只提供 HTML、CSS 與 JavaScript。

若某個掃描檔的圖片解不出來，先看瀏覽器主控台是不是擋了 wasm。`public/_headers` 已允許同一個來源的 WebAssembly。Cloudflare 上 `.wasm` 需要是 `application/wasm`；檔案裡已為 `/pdfjs/wasm/*` 指定這個類型。

## 座標

遮蓋存的是 PDF 使用者座標（原點在左下、Y 向上），經 pdf.js 的 viewport 轉換，所以縮放和頁面旋轉（0 / 90 / 180 / 270）不會讓位置跑掉。

- 畫面上的矩形用 `convertToPdfPoint` / `convertToViewportRectangle`。
- 一般匯出用 pdf-lib 把同一個使用者座標畫成實心矩形，旋轉仍由頁面的 `/Rotate` 負責，因此和原本內容對齊。
- 安全匯出用同一個 viewport 把頁面畫成圖片，再把遮蓋畫到像素上。新 PDF 不再保留旋轉旗標，因為方向已經烘進圖片。
