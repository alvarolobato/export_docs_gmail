# Google Docs to Stripo Email Export

Export Google Docs tabs to Stripo-formatted HTML with embedded images hosted on Google Drive, and automatically create Gmail drafts.

## 🎯 What This Does

This tool automates the process of converting Google Docs content into Stripo-compatible HTML email templates:

1. **Reads Google Docs Tabs** - Extracts content from specific tabs in a Google Doc
2. **Preserves Formatting** - Maintains all text styling (bold, italic, headings, links, colors, lists, tables)
3. **Handles Images** - Uploads images to Google Drive and embeds public URLs
4. **Smart Chips Support** - Converts person chips (contacts) to mailto: links and document links to regular href links
5. **Performance Optimized** - Skips re-uploading existing images to Drive
6. **Creates Gmail Drafts** - Automatically generates draft emails with proper formatting
7. **Organized Output** - Saves HTML files in dated subfolders for easy tracking

## ✨ Features

- ✅ Full text formatting support (H1-H6, bold, italic, underline, colors, links)
- ✅ List support (bullets and numbered)
- ✅ Table structure with embedded images
- ✅ Smart chip detection (person contacts → mailto:, document links → href)
- ✅ Line break preservation (source readability + visual breaks)
- ✅ Image caching (skip re-uploads of existing Drive files)
- ✅ Automatic Gmail draft creation
- ✅ Organized folder structure with date-stamped exports

## 📋 Prerequisites

### 1. Node.js
Install Node.js (v14 or higher):
```bash
node --version  # Verify installation
```

### 2. Google Cloud Project & Credentials

You need OAuth 2.0 credentials and app config in the **`config/`** folder (or in `~/.config/export_docs_gmail/` as fallback). For full steps, see **[CREDENTIALS.md](CREDENTIALS.md)**.

**Quick summary:** Create a Google Cloud project, enable Docs, Drive, and Gmail APIs, create a **Desktop app** OAuth client, and **download** the JSON from the console — save it as `config/credentials.json` (you do not copy from a template; the file comes from Google). For app settings (document ID, Drive folder, etc.), copy `config/config.json.template` to `config/config.json` and fill in your values. Then run `node auth.js` once to generate `config/token.json`. See **config/README.md** for details.

## 🚀 Installation

1. **Clone this repository**
   ```bash
   git clone https://github.com/alvarolobato/export_docs_gmail.git
   cd export_docs_gmail
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Add credentials and config**  
   See [CREDENTIALS.md](CREDENTIALS.md) and [config/README.md](config/README.md).
   - **credentials.json:** In Google Cloud Console, create a Desktop OAuth client and **download** the JSON. Save it as `config/credentials.json`. (The repo’s `credentials.json.template` is only a structure reference; the real file comes from Google.)
   - **config.json:** Copy the template and fill in your document ID, Drive folder ID, etc.
   ```bash
   # Save your downloaded OAuth client JSON as config/credentials.json
   cp config/config.json.template config/config.json
   # Edit config/config.json with your document ID, driveParentFolderId, etc.
   ```

4. **Authenticate (generates token.json)**  
   Run `node auth.js` once. It uses `credentials.json` to open the OAuth flow and then **writes** `token.json` (no manual copy).
   ```bash
   node auth.js
   ```
   - Follow the URL in your terminal, sign in with Google, grant permissions
   - Paste the authorization code back into the terminal
   - `token.json` will be created in `config/` (or `~/.config/export_docs_gmail/` if you use the fallback directory)

## 📖 Usage

### Interactive Mode (Recommended)
```bash
./run.sh
```

This script will:
1. List all tabs in your Google Doc
2. Let you select which tab to export
3. Extract all content with formatting
4. Upload new images to Drive (or reuse existing ones)
5. Save HTML to `emails/[date-tabname]/[filename].html`
6. Create a Gmail draft with the content

### Direct Export (Advanced)
```bash
node export.js
```

When prompted, enter:
- **Document ID**: The ID from your Google Doc URL  
  Example: `https://docs.google.com/document/d/YOUR_DOCUMENT_ID_HERE/edit`  
  Document ID: `YOUR_DOCUMENT_ID_HERE`
- **Tab ID**: The ID from the tab's URL parameter  
  Example: `https://docs.google.com/document/d/[DOC_ID]/edit#heading=h.t.XXXXXXXXXX`  
  Tab ID: `t.XXXXXXXXXX`
- **Drive Folder ID**: Where to save images (must have write access)

### List Document Tabs
```bash
node list-tabs.js
```

Displays all available tabs in a document with their IDs.

## 📁 Output Structure

```
emails/
└── YYYY-MM-DD___tab_name/
    ├── YYYY-MM-DD___tab_name.html  # Stripo-formatted HTML
    └── images/                     # (none if reusing existing Drive files)
```

Gmail draft subject format: `[tri-weekly] Observability Update YYYY-MM-DD`

## 🛠️ Configuration

All config (document ID, Drive folder, tracker URL, Gmail subject, etc.) is in **config/config.json**. Copy from `config/config.json.template` and set `driveParentFolderId`, `gmailSubjectPrefix`, etc. See [config/README.md](config/README.md) for the full format and env overrides.

## 🎨 How It Works

### Text Processing
- **Headings**: H1-H6 preserved from Google Docs styles
- **Formatting**: Bold, italic, underline, strikethrough, colors
- **Links**: Converted to `<a href="...">` tags
- **Lists**: Bullets (•) and numbered lists with proper indentation
- **Tables**: Full HTML table structure with embedded content
- **Line Breaks**: Both paragraph breaks and soft line breaks (`\n` and `\v` → `<br>`)

### Smart Chips
- **Person Chips**: Contact names/emails → `<a href="mailto:...">Name</a>`
- **Rich Link Chips**: Document/URL references → `<a href="...">Title</a>`

### Image Handling
1. Checks if image already exists in Drive folder (by filename)
2. If exists: Reuses file ID (shows "♻️ Reusing existing file")
3. If new: Uploads to Drive, sets public access, generates URL
4. Embeds direct download URL: `https://drive.google.com/uc?export=view&id=[FILE_ID]`

### Performance Optimization
- **Smart Caching**: Only uploads images that don't already exist in Drive
- **Example**: Document with 24 images, after first export all subsequent exports show:
  ```
  ♻️ Reusing existing file in Drive: image_abc123.png
  ```
  No network upload delay, instant processing!

## 🔧 Troubleshooting

### "Authentication failed"
- Delete `config/token.json` (or `~/.config/export_docs_gmail/token.json`)
- Run `node auth.js` again
- Make sure you granted all required permissions

### "Images not showing in email"
- Check Drive folder permissions (should be shared with "Anyone with link")
- Verify `driveParentFolderId` in `config/config.json` (or env `DRIVE_PARENT_FOLDER_ID`)
- Check image URLs in generated HTML start with `https://drive.google.com/uc?export=view&id=`

### "Tab not found"
- Use `node list-tabs.js` to verify tab ID
- Make sure you're using the correct document ID
- Tab IDs start with `t.` (e.g., `t.XXXXXXXXXX`)

### "Missing formatting"
- Ensure document uses Google Docs built-in styles (not manual sizing)
- Lists should use the toolbar buttons, not manual bullets
- Tables should be inserted via Insert → Table

## 📚 Project Structure

```
export_docs_gmail/
├── auth.js              # OAuth authentication setup
├── export.js            # Main export engine (~600 lines)
├── list-tabs.js         # Utility to list document tabs
├── run.js               # Interactive runner (tab selection)
├── run.sh               # Shell wrapper for run.js
├── package.json         # Node.js dependencies
├── config/                       # Credentials + app config (sensitive files gitignored; templates tracked)
│   ├── credentials.json.template # OAuth structure reference
│   ├── config.json.template      # App config format (doc ID, Drive folder, etc.)
│   ├── credentials.json         # Your OAuth client (add locally)
│   ├── config.json              # Your document/drive IDs, etc. (add locally)
│   └── token.json                # Generated by node auth.js
├── emails/              # Generated HTML exports (gitignored)
│   └── [date-tabname]/  # One folder per export
└── old/                 # Legacy/backup files
```

## 🤝 Contributing

Found a bug or have a feature request? [Open an issue](https://github.com/alvarolobato/export_docs_gmail/issues) on GitHub.

## 📄 License

MIT License - feel free to use this for your own projects!
