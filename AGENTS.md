# AGENTS.md - Development History & Architecture

## 1. Project Overview
**Name:** Google Docs to Stripo Email Export Tool
**Context:** This project automates the export of Google Docs tabs to Stripo-formatted HTML email templates with Gmail integration.

**Problem Solved:** 
- Email builders like Stripo require properly formatted HTML with public image URLs
- Direct copy-pasting from Google Docs loses formatting and images are local blobs
- Manual export is time-consuming and error-prone
- Need to maintain formatting: headings, lists, tables, colors, links, smart chips
- Images must be hosted and publicly accessible
- Line breaks and styling must be preserved exactly

**Solution Evolution:**
1. **Initial Approach (Google Apps Script)**: Exported to Google Sheets for Stripo's Smart Elements
2. **Current Approach (Node.js)**: Direct HTML generation with:
   - Google Docs API v1 for tab content extraction
   - Google Drive API for image hosting with public URLs
   - Gmail API for automatic draft creation
   - Local file system for organized HTML output
   - Performance optimization: skip re-uploading existing images

---

## 2. Architecture & Technology Stack

### Core Technologies
- **Node.js**: Runtime environment (v14+)
- **Google APIs Client Library**: `googleapis` npm package
- **OAuth 2.0**: Authentication with Google services
- **APIs Used**:
  - Google Docs API v1 (read document content with tab support)
  - Google Drive API v3 (upload and host images)
  - Gmail API v1 (create drafts)

### Key Dependencies
```json
{
  "googleapis": "^143.0.0",
  "axios": "^1.7.9",
  "readline": "^1.3.0",
  "stream": "^0.0.3"
}
```

### Authentication Flow
1. User creates OAuth 2.0 credentials in Google Cloud Console
2. Downloads `credentials.json` (OAuth client) to `config/`
3. On first run of `cli.js`, a local HTTP server captures the OAuth callback automatically
4. `token.json` is saved and reused (with automatic refresh)
5. Scopes required:
   - `https://www.googleapis.com/auth/documents.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/drive.file`

### Data Flow
```
cli.js (auth check → tab selection → date prompt)
    ↓
export.js: Google Doc (Tab) 
    ↓ [Docs API]
Document JSON (elements, styles, inline objects)
    ↓ [processing]
HTML Structure + Image URLs
    ↓ [File System]
emails/[tab-name]/[filename].html
    ↓ [Gmail API]
Gmail Draft (with subject + date)
```

### Image Hosting Strategy
```
1. Extract inline image from Docs API
2. Check if filename exists in Drive folder
   ├─ EXISTS → Reuse file ID (♻️ skip upload)
   └─ NEW → Upload to Drive
3. Set public permissions: ANYONE_WITH_LINK
4. Generate direct URL: https://drive.google.com/uc?export=view&id=[FILE_ID]
5. Embed in HTML <img> tag
```

---

## 3. File Structure & Responsibilities

### Core Files

#### `cli.js` (~310 lines)
**Purpose**: Unified CLI entry point — authentication, tab selection, date prompt, export orchestration
**Key Functions**:
- `parseArgs()`: Command-line argument parsing (-t, -n, -d, -l, --doc, -h)
- `ensureAuth()`: Checks for token.json, loads or triggers OAuth flow
- `runAuthFlow()`: OAuth with local HTTP server callback (no manual code pasting)
- `fetchTabs()`: Lists document tabs via Docs API
- `selectTab()`: Interactive selection (first 5 shown, "m" for more) or CLI override
- `promptDate()`: Date prompt with today as default, YYYY-MM-DD validation
- `main()`: Orchestrates the full guided flow

**CLI Options**:
- `-t <n>` / `--tab <n>`: Select tab by number
- `-n <text>` / `--tab-name <text>`: Select tab by name substring
- `-d <YYYY-MM-DD>` / `--date <date>`: Override date for tracker/subject
- `--doc <id>`: Override document ID
- `-l` / `--list-tabs`: List tabs and exit
- `-h` / `--help`: Show help

#### `export.js` (~620 lines)
**Purpose**: Export engine — converts Google Docs tab to HTML, uploads images, creates Gmail draft
**Key Functions**:
- `exportDoc({ docId, tabId, dateOverride, auth })`: Main entry point (callable from cli.js or standalone)
- `buildHTML(content, trackDate)`: Wraps content in Stripo email template
- `processParagraph()`: Handles text, formatting, smart chips, line breaks
- `processContent()`: Recursively processes document elements including tables
- Internal: Image upload with Drive reuse, Gmail draft creation

#### `load-config.js` (~90 lines)
**Purpose**: Config resolution with fallback paths
**Key Functions**:
- `resolvePath()`: Checks config/ then ~/.config/export_docs_gmail/
- `getCredentialsPath()`, `getTokenPath()`, `getConfigDirForWriting()`
- `loadAppConfig()`: Merges defaults, config.json, and env overrides

---

## 4. Document Processing Logic

### Element Type Handling

The export.js processes these Google Docs element types:

| Element Type | Processing | Output |
|--------------|------------|--------|
| `PARAGRAPH` | Extract text runs, apply formatting, detect headings | `<p>`, `<h1>`-`<h6>` with inline styles |
| `TABLE` | Iterate rows → cells → child elements | `<table><tr><td>...</td></tr></table>` |
| `TABLE_ROW` | Container for cells | `<tr>` |
| `TABLE_CELL` | Contains paragraphs/images | `<td>` |
| `LIST_ITEM` | Check nesting level, apply bullet/number | `• ` or `1. ` with indentation |
| `INLINE_IMAGE` | Extract blob, upload to Drive, get URL | `<img src="https://drive.google.com/...">` |

### Smart Chip Support

**Person Chips** (Contact Information):
```javascript
// Google Docs API structure
{
  person: {
    personProperties: {
      name: "John Doe",
      email: "john@example.com"
    }
  }
}

// Converted to
<a href="mailto:john@example.com" style="...">John Doe</a>
```

**Rich Link Chips** (Document/URL References):
```javascript
// Google Docs API structure
{
  richLink: {
    richLinkProperties: {
      title: "RCA Document",
      uri: "https://docs.google.com/..."
    }
  }
}

// Converted to
<a href="https://docs.google.com/..." style="..."><u>RCA Document</u></a>
```

### Text Formatting Mapping

| Google Docs Style | HTML Output |
|-------------------|-------------|
| Bold | `<strong>` |
| Italic | `<em>` |
| Underline | `<u>` |
| Strikethrough | `<s>` |
| Link | `<a href="...">` |
| Text Color | `<span style="color:rgb(...)">` |
| Background Color | `<span style="background-color:rgb(...)">` |

### Line Break Handling

**Challenge**: Google Docs uses two types of line breaks:
1. `\n` - Hard paragraph break (Enter key)
2. `\v` (vertical tab) - Soft line break (Shift+Enter)

**Solution**: 
```javascript
// Detect line breaks at start/end
const hasLineBreakAtEnd = /[\n\v]$/.test(text);
const hasLineBreakAtStart = /^[\n\v]/.test(text);

// Strip temporarily, process formatting
text = text.replace(/[\n\v]/g, '');
// ... apply bold, italic, etc ...

// Place <br> OUTSIDE formatting tags
if (hasLineBreakAtStart) paraText += '<br>';
paraText += formattedText;
if (hasLineBreakAtEnd) paraText += '<br>';
```

**Why Outside?**: Email clients render `<strong><br></strong>` poorly. Must be `</strong><br>`.

---

## 5. Evolution & Key Fixes

### Issue #1: Images Not Embedding in Tables (Fixed)
**Problem**: Images inside tables weren't appearing in HTML
**Root Cause**: `processParagraph()` modified global `htmlContent` variable before table processing completed
**Solution**: Changed `processParagraph()` to return HTML string instead of modifying global
**Impact**: All 10 tables now render correctly with embedded images

### Issue #2: Slow Re-Exports (Fixed)
**Problem**: Re-exporting same document uploaded all 24 images every time (~30 seconds delay)
**Root Cause**: No check for existing files in Drive
**Solution**: 
```javascript
// Check if file exists
const existingFiles = await drive.files.list({
  q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
  fields: 'files(id, name)'
});

if (existingFiles.data.files.length > 0) {
  console.log('♻️ Reusing existing file in Drive:', filename);
  return existingFiles.data.files[0].id;
}
```
**Impact**: Subsequent exports instant (0 uploads), huge performance gain

### Issue #3: Unreadable HTML Source (Fixed)
**Problem**: Generated HTML was one long line, hard to inspect
**Solution**: Added `\n` line breaks after every paragraph and throughout table structures
**Impact**: Source HTML now human-readable for debugging

### Issue #4: Wrong Heading Style Applied (Fixed)
**Problem**: Paragraph with link at start + 30+ chars text got HEADING_2 style
**Root Cause**: Google Docs API reports namedStyleType as HEADING_2 for certain link patterns
**Solution**: Override detection
```javascript
if (namedStyleType.startsWith('HEADING_') && 
    hasLinkAtStart && 
    totalTextLength > 30) {
  namedStyleType = 'NORMAL_TEXT';
}
```
**Impact**: Correct `<p>` tag instead of `<h2>` for long paragraphs with links

### Issue #5: Google Doc Chips Not Converting (Fixed)
**Problem**: Document link chips (e.g., RCA links) appeared as plain text
**Root Cause**: Only `person` chips were handled, `richLink` chips ignored
**Solution**: Added richLink element processing with title and URI extraction
**Impact**: All smart chips now convert to proper HTML links

### Issue #6: Line Breaks Not Preserved (Fixed)
**Problem**: "Before" and "Metrics Experience" on same line instead of separate lines
**Root Cause**: Line break characters (\v) stripped before formatting, never added back
**Solution**: Detect line breaks first, apply formatting, then place `<br>` outside tags
**Impact**: Visual line breaks preserved, email renders correctly

---

## 6. Configuration & Customization

### Drive Folder for Images
```javascript
// export.js line ~50
// driveParentFolderId in config/config.json (or env DRIVE_PARENT_FOLDER_ID)
```
Change this to your target folder ID. Must have:
- Write access
- Shared with "Anyone with link" (or script sets this automatically)

### Output Folder Structure
```javascript
// export.js line ~540
const sanitizedTabName = tabName.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
const outputDir = path.join(__dirname, 'emails', `${formattedDate}___${sanitizedTabName}`);
```
Format: `emails/YYYY_MM_DD___tab_name/`

### Gmail Draft Subject
```javascript
// export.js line ~530
const subject = `[tri-weekly] Observability Update ${formattedDate}`;
```
Customize prefix, format, or add variables

### HTML Styling (Stripo Format)
All inline styles use Stripo's conventions:
- Font: Helvetica, Arial, sans-serif
- Colors: RGB format `rgb(0, 0, 0)`
- Links: Color `rgb(17, 85, 204)` with underline
- Line height: 1.38 for paragraphs
- Margins: Specific px values for each heading level

---

## 7. Known Limitations & Edge Cases

### Supported Features
✅ Text formatting (bold, italic, underline, strikethrough, colors)
✅ Headings (H1-H6)
✅ Links (regular and smart chips)
✅ Lists (bullets and numbered, with nesting)
✅ Tables (with embedded images and text)
✅ Images (uploaded to Drive, public URLs)
✅ Person chips (contact emails)
✅ Rich link chips (document links)
✅ Line breaks (hard and soft)

### Not Supported
❌ **Equations**: Google Docs equations not accessible via API
❌ **Drawings**: Google Drawings embedded in docs (use Insert → Image instead)
❌ **Comments**: Document comments are ignored
❌ **Suggestions**: Track changes/suggestions not processed
❌ **Page Breaks**: No equivalent in email HTML
❌ **Headers/Footers**: Not part of document body
❌ **Footnotes**: Not extracted

### Edge Cases Handled
- **Empty paragraphs**: Converted to `<br>` for spacing
- **Images without filenames**: Generated with timestamp
- **Nested tables**: Recursively processed (though rare)
- **Very long tables**: All rows processed (tested with 50+ row tables)
- **Special characters**: Properly escaped for HTML
- **Multiple tabs**: User selects specific tab, others ignored

---

## 8. Testing & Validation

### Test Document
- **Document ID**: `1y6i0wbfqSCZsoEEcYQ6xJyOJrY2Lll4YZ08fKnX2Ue0`
- **Test Tab**: `t.kjc15gcfsw0t` ("2026-01-31 - Iteration 122")
- **Content**: 24 images, 10 tables, multiple headings, lists, smart chips

### Verification Steps
1. **Formatting**: Compare source Google Doc with generated HTML (visual inspection)
2. **Images**: Check all images display in Gmail draft
3. **Performance**: Verify "♻️ Reusing" messages for existing images
4. **Line breaks**: Inspect HTML source with `od -c` for `<br>` placement
5. **Tables**: Count rows/columns match source
6. **Smart chips**: Verify mailto: and href links work

### Known Working Scenarios
✅ 24 images all reusing existing Drive files (0 uploads)
✅ 10 tables with complex nested content
✅ Person chips converting to mailto: links with names
✅ Rich link chips converting to document URLs
✅ Line breaks preserved: "Before</strong><br>Metrics"
✅ Heading override for long paragraphs with links
✅ Empty paragraphs → spacing maintained

---

## 9. File Organization & Project Structure

### Current Structure
```
export_docs_gmail/
├── cli.js               # Unified CLI: auth, tab selection, date, export
├── export.js            # Export engine: HTML generation, Drive upload, Gmail draft
├── load-config.js       # Config loader with fallback paths
├── run.sh               # Shell wrapper for cli.js
├── package.json         # Dependencies
├── config/              # Credentials + app config (sensitive files gitignored; templates + README tracked)
│   ├── credentials.json.template  # OAuth structure reference
│   ├── config.json.template       # App config format
│   └── README.md                  # Config documentation
├── emails/              # Generated exports (gitignored)
│   └── [tab-name]/      # One folder per export
│       └── [filename].html
├── .gitignore           # Excludes credentials, emails, node_modules
├── README.md            # User documentation
├── CREDENTIALS.md       # Credential setup guide
└── AGENTS.md            # This file (architecture & development history)
```

### .gitignore Contents
```
config/credentials.json
config/token.json
config/config.json
emails/
node_modules/
*.eml
*.log
.DS_Store
```

---

## 10. Development Workflow & Best Practices

### Making Changes

1. **Test with Known Document**: Use the test document ID to verify changes
2. **Check Image Reuse**: Ensure "♻️ Reusing" messages appear (performance)
3. **Inspect HTML Source**: Use `cat emails/[path]/[file].html` to verify structure
4. **Visual Check**: Open Gmail draft to see rendered output
5. **Line Break Validation**: Use `od -c emails/[path]/[file].html | grep "<br>"` to verify placement

### Common Modification Points

**Change Image Hosting**:
- Lines 350-395 in export.js
- Replace Drive API calls with different hosting service

**Add New Element Type**:
- Add case in `processStructuralElement()` around line 220
- Implement processing function (follow existing patterns)

**Modify HTML Structure**:
- Update `processParagraph()` for text elements
- Update `processTable()` for table structure
- Update `convertTextToHtml()` for inline styling

**Change OAuth Scopes**:
- Update `SCOPES` in cli.js
- Delete token.json and re-authenticate

### Debugging Tips

**Enable API Response Logging**:
```javascript
// Add after docs.documents.get() call
console.log(JSON.stringify(document, null, 2));
```

**Trace Element Processing**:
```javascript
// Add in processStructuralElement()
console.log(`Processing: ${element.type}`);
```

**Check Drive Upload**:
```javascript
// Add in processInlineImage() after upload
console.log(`Uploaded: ${fileId}, URL: ${imageUrl}`);
```

---

## 11. Future Enhancement Ideas

### Potential Improvements
- **Multi-document Export**: Batch export multiple documents
- **Template Support**: Allow custom HTML templates
- **Stripo API Integration**: Direct upload to Stripo instead of Gmail
- **Image Optimization**: Compress images before upload
- **Table Styling**: More sophisticated table formatting
- **Link Validation**: Check if URLs are accessible
- **Export Formats**: Add JSON, Markdown output options
- **Undo/Rollback**: Keep version history of exports

### Performance Optimizations
- **Parallel Image Uploads**: Upload multiple images concurrently
- **Drive API Batching**: Batch file list requests
- **Local Image Cache**: Store image metadata locally
- **Incremental Export**: Only re-process changed content

### User Experience
- **GUI**: Electron app for non-technical users
- **Browser Extension**: Export directly from Google Docs interface
- **Preview Mode**: Show HTML preview before creating draft
- **Export History**: Track all exports with metadata

---

## 12. Troubleshooting Guide

### Authentication Issues

**"Error: invalid_grant"**
- Token expired or revoked
- Solution: Delete token in config/ or ~/.config/export_docs_gmail, run `node cli.js`

**"Access denied"**
- Missing required scopes
- Solution: Check SCOPES in cli.js, re-authenticate

### API Errors

**"Document not found"**
- Incorrect document ID
- Document not shared with authenticated account
- Solution: Verify ID, check sharing settings

**"Tab not found"**
- Incorrect tab ID or tab deleted
- Solution: Use `node cli.js -l` to get current tab names

**"Drive upload failed"**
- Insufficient permissions on Drive folder
- Folder doesn't exist
- Solution: Verify driveParentFolderId in config/config.json (or env), check folder permissions

### Output Issues

**Images not showing**
- Drive permissions not set to public
- Incorrect image URL format
- Solution: Check file.setPermissions call in export.js

**Formatting lost**
- Google Docs using manual formatting instead of styles
- Solution: Use built-in heading styles, toolbar buttons for lists

**Line breaks missing**
- Old version of export.js
- Solution: Update to latest version with \v handling

### Performance Issues

**Slow exports**
- Not reusing existing images
- Solution: Check for "♻️ Reusing" messages, verify Drive API query

**Memory errors**
- Very large documents (100+ pages)
- Solution: Export tab-by-tab instead of whole document

---

## 13. Conversation History Summary

### Development Timeline

1. **Initial Request**: Export Google Docs tabs to Stripo-formatted HTML locally with Gmail draft creation
2. **Image Strategy Evolution**: 
   - First attempt: `cid:` inline images (failed, Gmail doesn't support)
   - Second attempt: Drive hosting with public URLs (success)
3. **Performance Optimization**: Added skip-upload logic for existing images
4. **Styling Fixes**: Fixed heading detection for link-heavy paragraphs
5. **Smart Chips**: Added person chip and rich link chip support
6. **Line Breaks**: Fixed soft line break preservation (\v → <br>)
7. **Project Organization**: Created config/ (credentials + app config), fallback to ~/.config/export_docs_gmail; old/ for legacy files

### Key Decisions Made

**Why Node.js instead of Google Apps Script?**
- More control over HTML structure
- Better error handling and logging
- Local file system access
- Direct Gmail API integration

**Why Drive for image hosting?**
- Already authenticated with Drive API
- Free unlimited storage (with Google Workspace)
- Reliable CDN for email delivery
- Easy permission management

**Why skip existing uploads?**
- 24 images × ~2 seconds each = 48 seconds saved per export
- Reduces API quota usage
- No visual difference (same images)

**Why config/ folder?**
- Security: Keep sensitive files separate
- .gitignore: Easier to exclude from version control
- Organization: Clear purpose for folder

### Verified Working Features
✅ Export tested on document with 24 images, 10 tables, complex formatting
✅ All images reusing existing Drive files (0 uploads after first run)
✅ Gmail draft created with proper subject formatting
✅ Line breaks preserved correctly (verified with od -c)
✅ Person chips → mailto: links working
✅ Rich link chips → href links working
✅ Table structure intact with embedded images
✅ Heading override for link-heavy paragraphs working

---

## 14. API Usage & Quotas

### Google Docs API
- **Quota**: 300 requests per minute per user
- **Usage**: 1 request per export (documents.get)
- **Fields**: `fields: '*'` to get complete document structure

### Google Drive API
- **Quota**: 1,000 requests per 100 seconds per user
- **Upload Quota**: 750 GB per day
- **Usage**: 
  - 1 request per export (files.list to check existing)
  - N requests for new images (files.create + permissions.create)

### Gmail API
- **Quota**: 250 quota units per second per user
- **Usage**: 1 request per export (drafts.create)
- **Cost**: 5 units per draft creation

### Optimization Strategies
- **Drive**: Reuse existing files (implemented)
- **Docs**: Cache document structure (not implemented, could add)
- **Gmail**: Batch draft creation (not needed, 1 draft per export)

---

## 15. Security Considerations

### Credential Management
- **credentials.json**: OAuth client ID (not highly sensitive but should not be public)
- **token.json**: Access token (VERY sensitive, grants API access)
- Sensitive files (credentials.json, token.json, config.json) in config/ excluded via .gitignore; templates tracked

### Drive Permissions
- Images set to "Anyone with link" can view
- Folder permissions should be restricted to owner + script
- Consider: Time-limited sharing or signed URLs for extra security

### OAuth Scopes
Current scopes are minimal required:
- `documents.readonly`: Cannot modify documents
- `drive.file`: Can only access files created by this app
- `gmail.compose`: Can only create drafts, not send automatically

### Best Practices
✅ Never commit credentials.json or token.json
✅ Use environment variables for production deployment
✅ Regularly rotate OAuth tokens (Google does this automatically)
✅ Review Drive folder contents periodically
✅ Use separate Google Cloud project for production

---

## 16. Deployment & Production Use

### Local Development
Current setup is optimized for local use:
- Manual authentication via browser OAuth flow
- Credentials stored in local file system
- Interactive CLI for tab selection

### Production Considerations

**Service Account Authentication**:
```javascript
// Instead of OAuth, use service account
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account-key.json',
  scopes: SCOPES,
});
```

**Environment Variables**:
```javascript
const driveParentFolderId = process.env.DRIVE_PARENT_FOLDER_ID || config.driveParentFolderId;
const DOCUMENT_ID = process.env.DOCUMENT_ID;
```

**Error Handling**:
```javascript
try {
  await exportToStripo(documentId, tabId, folderId);
} catch (error) {
  console.error('Export failed:', error);
  // Send alert to monitoring service
  // Retry logic
}
```

**Logging**:
```javascript
// Replace console.log with proper logger
const winston = require('winston');
logger.info('Export started', { documentId, tabId });
```

### Automation Options
- **Cron Job**: Schedule exports (e.g., daily at 9 AM)
- **Webhook**: Trigger export on Google Docs update
- **CI/CD**: Integrate with GitHub Actions
- **Cloud Function**: Deploy as serverless function

---

## 17. Related Documentation

### Official API Documentation
- [Google Docs API](https://developers.google.com/docs/api)
- [Google Drive API](https://developers.google.com/drive/api)
- [Gmail API](https://developers.google.com/gmail/api)
- [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)

### Project Documentation
- [README.md](README.md): User guide and setup instructions
- [CREDENTIALS.md](CREDENTIALS.md): Credential setup guide
- [package.json](package.json): Dependencies and scripts

### External Resources
- [Stripo Email Editor](https://stripo.email/)
- [Node.js googleapis](https://github.com/googleapis/google-api-nodejs-client)
- [Google Cloud Console](https://console.cloud.google.com/)

---

**Last Updated**: 2026-01-31  
**Status**: Production-ready, actively maintained  
**Total Lines of Code**: ~930 lines (cli.js: 310, export.js: 620, load-config.js: 90)