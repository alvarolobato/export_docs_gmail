#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const stream = require('stream');
const config = require('./load-config');

const LINK_STYLE = 'color:#1a73e8;text-decoration:none';

// ---------------------------------------------------------------------------
// Post-process assembled HTML content to enforce consistent vertical spacing.
//
// Google Docs uses empty paragraphs for visual spacing, which become bare <br>
// tags on their own line. These are inherently inconsistent: the same doc may
// have 0, 1, or 3 empty paragraphs between sections depending on the author.
//
// Instead of relying on <br> for spacing we use CSS margins everywhere:
//   - Paragraphs: margin-bottom provides inter-paragraph spacing.
//   - Headings: margin-top provides pre-heading breathing room.
//   - Images: margin (top+bottom) provides surrounding space.
//   - Lists: margin-top/bottom already set.
//
// This function strips every standalone <br> (one that sits on its own line,
// originating from an empty Google Doc paragraph) while leaving inline <br>
// tags alone (e.g. soft line breaks within a paragraph).
// ---------------------------------------------------------------------------
// Elastic corporate colors for H3 section accent bars (pink reserved for jobs).
const ACCENT_COLORS = ['#0077CC', '#00BFB3', '#FEC514'];
const ACCENT_TEXT   = ['#fff',    '#fff',    '#1a1a1a'];

// Wrap each H3 section (heading + ALL content until the next H1/H2/H3) into a
// card with a coloured left accent bar. The colour rotates per H2 section.
function applyH3Cards(html) {
  const lines = html.split('\n');
  const out = [];
  let h2Idx = -1;
  let inCard = false;

  function closeCard() {
    if (inCard) { out.push('</td></tr></table>'); inCard = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^<h1\b/.test(line)) {
      closeCard();
      out.push(line);
      continue;
    }

    if (/^<h2\b/.test(line)) {
      closeCard();
      h2Idx++;
      const ci = h2Idx % ACCENT_COLORS.length;
      const color = ACCENT_COLORS[ci];
      const textColor = ACCENT_TEXT[ci];
      const idMatch = line.match(/\bid="([^"]*)"/);
      const idAttr = idMatch ? ` id="${idMatch[1]}"` : '';
      let inner = line.replace(/^<h2\b[^>]*>([\s\S]*)<\/h2>$/, '$1');
      inner = inner.replace(/style="[^"]*"/g, `style="color:${textColor};text-decoration:none"`);
      out.push(`<h2${idAttr} style="background:${color};color:${textColor};font:700 18px/24px arial,sans-serif;margin:20px 0 6px;padding:10px 16px;border-radius:4px">${inner}</h2>`);
      continue;
    }

    if (/^<h3\b/.test(line)) {
      closeCard();
      const color = ACCENT_COLORS[Math.max(h2Idx, 0) % ACCENT_COLORS.length];
      const idMatch = line.match(/\bid="([^"]*)"/);
      const idAttr = idMatch ? ` id="${idMatch[1]}"` : '';
      const inner = line.replace(/^<h3\b[^>]*>([\s\S]*)<\/h3>$/, '$1');

      out.push(`<table class="cd" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;margin:3px 0 6px"><tr><td width="5" style="background:${color}"></td><td${idAttr} style="background:#fafafa;padding:10px 14px;border:1px solid #eaeaea;border-left:0;font:12px/17px arial,sans-serif;color:#5f6368">`);
      out.push(`<p style="margin:0;font:700 16px/22px arial,sans-serif;color:#202124">${inner}</p>`);
      inCard = true;
      continue;
    }

    if (inCard) {
      if (/^<p\b/.test(line)) {
        out.push(line.replace(/style="[^"]*"/, 'style="margin:4px 0 0"'));
      } else if (/^<h[4-6]\b/.test(line)) {
        out.push(line
          .replace(/style="[^"]*"/, 'style="margin:8px 0 2px;font-weight:700;color:#000"')
          .replace(/<(h[4-6])\b/, '<p').replace(/<\/(h[4-6])>/, '</p>'));
      } else if (/<img\b/.test(line)) {
        out.push(line.replace(/width="\d+"/, 'width="100%"').replace(/style="([^"]*)"/, 'style="$1;max-width:100%"'));
      } else if (/^<br>$/.test(line)) {
        // skip standalone breaks inside cards
      } else {
        out.push(line);
      }
      continue;
    }

    out.push(line);
  }

  closeCard();
  return out.join('\n');
}

function normalizeSpacing(html) {
  html = html.replace(/^<br>\n/gm, '');

  // When a heading directly follows another heading, collapse the second
  // heading's margin-top to keep heading hierarchies visually tight.
  html = html.replace(
    /(<\/h[1-6]>\n<h[1-6]\b[^>]*style="[^"]*?)margin:\d+px 0 0/g,
    '$1margin:0'
  );

  // Merge adjacent same-type lists to avoid per-item <ul>/<ol> wrappers.
  html = html.replace(/<\/ul>\n<ul style="[^"]*">/g, '');
  html = html.replace(/<\/ol>\n<ol style="[^"]*">/g, '');

  html = applyH3Cards(html);

  return html;
}

// Derive header label and title from gmailSubjectPrefix when not explicitly configured.
// e.g. "[bi-weekly] Observability Update" → label "OBSERVABILITY", title "Bi-Weekly Update"
function deriveHeaderText() {
  const prefix = config.gmailSubjectPrefix || '';
  const bracketMatch = prefix.match(/\[([^\]]+)\]/);
  const afterBracket = prefix.replace(/\[[^\]]*\]\s*/, '').trim();

  const label = config.emailHeaderLabel
    || (afterBracket ? afterBracket.toUpperCase() : 'UPDATE');
  const title = config.emailHeaderTitle
    || (bracketMatch ? bracketMatch[1].split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-') + ' Update' : afterBracket || 'Update');
  return { label, title };
}

// Generate full HTML email
function buildHTML(content, trackDate, { tabName = '', formattedDate = '' } = {}) {
  const iterMatch = tabName.match(/Iteration\s+\d+/i);
  const iterLabel = iterMatch ? iterMatch[0] : '';
  const displayDate = formattedDate || trackDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const { label: headerLabel, title: headerTitle } = deriveHeaderText();
  const titleText = `${headerLabel} ${displayDate}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titleText}</title><style>img.adapt-img{display:block;border:0;margin:14px 0}@media(max-width:600px){img.adapt-img{width:100%!important;height:auto!important}h1{font-size:36px!important;line-height:44px!important}h2{font-size:26px!important;line-height:34px!important;margin-left:-4px!important;margin-right:-4px!important;border-radius:0!important}p,li,td{font-size:21px!important;line-height:30px!important}}</style></head>
<body style="width:100%;padding:0;margin:0">
<div style="background:#F6F6F6">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#F6F6F6"><tr><td align="center">
<table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" style="border-collapse:collapse;background:#fff;width:100%;max-width:860px">
<tr><td align="center" style="padding:24px 12px 0;font:14px/21px arial,sans-serif;color:#333">
<img src="${config.trackerBaseUrl}${trackDate}" alt="" width="128" style="display:block;border:0;margin:0">
<p style="margin:0;line-height:16px;letter-spacing:1.5px;color:#999;font-size:11px;text-transform:uppercase;padding-top:16px">${headerLabel}</p>
<h1 style="margin:0;font:700 26px/34px arial,sans-serif;color:#222;padding-top:10px">${headerTitle}</h1>
<p style="margin:0;line-height:20px;color:#999;font-size:13px;padding:10px 0 4px">${displayDate}${iterLabel ? ' &middot; ' + iterLabel : ''}</p>
</td></tr>
<tr><td style="padding:8px 4px"><hr style="border:0;border-top:1px solid #e0e0e0;margin:0"></td></tr>
<tr><td align="left" style="padding:10px 4px;font:14px/21px arial,sans-serif;color:#333">${content}</td></tr>
<tr><td style="padding:0 4px 8px"><hr style="border:0;border-top:1px solid #e0e0e0;margin:0"></td></tr>
<tr><td align="center" style="padding:0 20px 24px"><p style="margin:0;font:12px/18px arial,sans-serif;color:#bbb">Observability Team &mdash; Elastic</p></td></tr>
</table></td></tr></table>
</div></body></html>`;
}

// Build job listing cards HTML from cached job data (injected directly, not from doc).
function buildJobCardsHTML(jobs) {
  if (!jobs || jobs.length === 0) return '';

  let html = '';
  for (const job of jobs) {
    const title = (job.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const summary = (job.summary || job.description || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const url = job.url || '';
    const code = job.jobCode || '';

    const titleHtml = url
      ? `<a href="${url}" style="color:#202124;text-decoration:none">${title}</a>`
      : title;

    const pill = url && code
      ? `<td align="right" style="white-space:nowrap;padding-left:8px"><a href="${url}" style="display:inline-block;background:#F04E98;color:#fff;font:700 10px/14px arial,sans-serif;padding:3px 10px;border-radius:10px;text-decoration:none;letter-spacing:.3px">${code} &rarr;</a></td>`
      : code
        ? `<td align="right" style="white-space:nowrap;padding-left:8px"><span style="display:inline-block;background:#F04E98;color:#fff;font:700 10px/14px arial,sans-serif;padding:3px 10px;border-radius:10px;letter-spacing:.3px">${code}</span></td>`
        : '';

    const summaryHtml = summary
      ? `\n<p style="margin:4px 0 0;font:12px/17px arial,sans-serif;color:#5f6368">${summary}</p>`
      : '';

    html += `<table class="cd" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;margin:3px 0 6px"><tr><td width="5" style="background:#F04E98"></td><td style="background:#fafafa;padding:10px 14px;border:1px solid #eaeaea;border-left:0"><table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse"><tr><td style="font:700 14px/18px arial,sans-serif">${titleHtml}</td>${pill}</tr></table>${summaryHtml}</td></tr></table>\n`;
  }
  return html;
}

// Inject job cards into HTML after the "Career Opportunities" heading.
function injectJobCards(html, jobs) {
  if (!jobs || jobs.length === 0) return html;
  const heading = config.careersSectionHeading || 'Career Opportunities';
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<h[1-6][^>]*>[\\s\\S]*?${escapedHeading}[\\s\\S]*?</h[1-6]>)\\n`, 'i');
  const cardsHtml = buildJobCardsHTML(jobs);
  if (pattern.test(html)) {
    return html.replace(pattern, `$1\n${cardsHtml}`);
  }
  return html;
}

async function exportDoc(params = {}) {
  const DOC_ID = params.docId || process.argv[2] || config.documentId;
  const TAB_ID = params.tabId || process.argv[3] || config.defaultTabId;
  const dateOverride = params.dateOverride;

  console.log('\n🚀 Starting export...\n');

  let auth;
  if (params.auth) {
    auth = params.auth;
  } else {
    const credentials = JSON.parse(fs.readFileSync(config.getCredentialsPath()));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(JSON.parse(fs.readFileSync(config.getTokenPath())));
  }
  
  const docs = google.docs({ version: 'v1', auth });
  const gmail = google.gmail({ version: 'v1', auth });
  
  // Get doc
  console.log('📥 Fetching document...');
  const doc = await docs.documents.get({ 
    documentId: DOC_ID, 
    includeTabsContent: true,
    fields: '*'  // Include all fields including inlineObjects
  });
  
  // Find tab
  let tabName = 'unknown';
  let tabContent = null;
  
  if (doc.data.tabs) {
    for (const tab of doc.data.tabs) {
      if (tab.tabProperties?.tabId === TAB_ID) {
        tabContent = tab.documentTab?.body?.content;
        tabName = tab.tabProperties.title || 'Untitled';
        // Get inline objects from tab
        if (tab.documentTab?.inlineObjects) {
          doc.data.inlineObjects = tab.documentTab.inlineObjects;
        }
        break;
      }
    }
  }
  
  if (!tabContent) throw new Error(`Tab ${TAB_ID} not found`);
  
  console.log(`✓ Found tab: ${tabName}`);
  
  // Create output folder
  const folder = path.join(config.outputDir, tabName.replace(/[^a-z0-9]/gi, '_').toLowerCase());
  fs.mkdirSync(folder, { recursive: true });
  console.log(`✓ Created folder: ${folder}`);
  
  // Create Drive subfolder for images
  const drive = google.drive({ version: 'v3', auth });
  const PARENT_FOLDER_ID = config.driveParentFolderId;
  const date = dateOverride || new Date().toISOString().split('T')[0];
  const driveFolderName = `${date} - ${tabName}`;
  
  // Check if folder already exists
  const existingFolders = await drive.files.list({
    q: `name='${driveFolderName}' and '${PARENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  
  let driveFolder;
  if (existingFolders.data.files && existingFolders.data.files.length > 0) {
    driveFolder = { data: { id: existingFolders.data.files[0].id } };
    console.log(`✓ Using existing Drive folder: ${driveFolderName}`);
  } else {
    driveFolder = await drive.files.create({
      resource: {
        name: driveFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [PARENT_FOLDER_ID]
      },
      fields: 'id'
    });
    console.log(`✓ Created Drive folder: ${driveFolderName}`);
  }
  
  // In fast mode, pre-fetch the full file list from the Drive folder so we
  // can skip individual per-image API calls later.
  let driveFileIndex = null;
  if (params.fast) {
    const listing = await drive.files.list({
      q: `'${driveFolder.data.id}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 1000,
    });
    driveFileIndex = {};
    for (const f of (listing.data.files || [])) {
      driveFileIndex[f.name] = f.id;
    }
    console.log(`⚡ Fast mode — ${Object.keys(driveFileIndex).length} file(s) already in Drive folder`);
  }

  // Process content
  console.log('\n📝 Processing content...');
  let htmlContent = '';
  let imageCount = 0;
  const uploadedImages = {}; // Track uploaded images to avoid duplicates
  
  // Helper function to process paragraph
  async function processParagraph(para) {
    let paraText = '';
    let paraImages = '';  // Collect images for this paragraph
    let hasImage = false;
    
    // Process paragraph elements
    if (para.elements) {
      for (const elem of para.elements) {
        // Handle person chips (contact chips)
        if (elem.person) {
          const personId = elem.person.personId;
          const properties = elem.person.personProperties;
          const name = properties?.name || '';
          const email = properties?.email || '';
          
          if (email) {
            // Add space before person chip if needed
            if (paraText && !paraText.endsWith(' ')) paraText += ' ';
            paraText += `<a href="mailto:${email}" style="color:#333;text-decoration:none;background-color:#F9A8CC;padding:2px 8px;border-radius:12px;font-size:12px;white-space:nowrap">${name || email}</a> `;
          } else if (name) {
            if (paraText && !paraText.endsWith(' ')) paraText += ' ';
            paraText += name + ' ';
          }
          continue;
        }
        
        // Handle rich link chips (document links, etc.)
        if (elem.richLink) {
          const richLinkProperties = elem.richLink.richLinkProperties;
          const title = richLinkProperties?.title || 'Link';
          const url = richLinkProperties?.uri || '';
          
          if (url) {
            // Add space before link chip if needed
            if (paraText && !paraText.endsWith(' ')) paraText += ' ';
            paraText += `<a href="${url}" style="${LINK_STYLE}">${title}</a> `;
          }
          continue;
        }
        
        // Handle images
        if (elem.inlineObjectElement) {
          const objId = elem.inlineObjectElement.inlineObjectId;
          const img = doc.data.inlineObjects?.[objId];
          const url = img?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
          
          if (url) {
            imageCount++;
            const fastMode = params.fast;
            
            try {
              // In fast mode, look up the pre-fetched Drive index (no API call)
              if (fastMode && driveFileIndex) {
                const prefix = `image_${imageCount}.`;
                const match = Object.keys(driveFileIndex).find(n => n.startsWith(prefix));
                if (match) {
                  const imageUrl = config.getDriveImageUrl(driveFileIndex[match]);
                  uploadedImages[match] = imageUrl;
                  paraImages += `<img src="${imageUrl}" alt="" width="760" class="adapt-img" style="display:block;margin:14px 0;max-width:100%;height:auto">`;
                  hasImage = true;
                  console.log(`  ♻️  image ${imageCount} — reusing from Drive`);
                  continue;
                }
              }

              console.log(`  📥 Downloading & uploading image ${imageCount} to Drive...`);
              const response = await axios.get(url, { responseType: 'arraybuffer' });
              
              const contentType = response.headers['content-type'] || 'image/jpeg';
              const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
              const filename = `image_${imageCount}.${ext}`;
              
              fs.writeFileSync(path.join(folder, filename), response.data);
              
              const existingFiles = await drive.files.list({
                q: `name='${filename}' and '${driveFolder.data.id}' in parents and trashed=false`,
                fields: 'files(id)',
                spaces: 'drive'
              });
              
              let driveFileId;
              if (existingFiles.data.files && existingFiles.data.files.length > 0) {
                driveFileId = existingFiles.data.files[0].id;
                console.log(`    ♻️  Reusing existing file in Drive`);
              } else {
                const bufferStream = new stream.PassThrough();
                bufferStream.end(response.data);
                const driveFile = await drive.files.create({
                  resource: {
                    name: filename,
                    parents: [driveFolder.data.id]
                  },
                  media: {
                    mimeType: contentType,
                    body: bufferStream
                  },
                  fields: 'id'
                });
                driveFileId = driveFile.data.id;
                
                await drive.permissions.create({
                  fileId: driveFileId,
                  requestBody: {
                    role: 'reader',
                    type: 'anyone'
                  }
                });
              }
              
              const imageUrl = config.getDriveImageUrl(driveFileId);
              uploadedImages[filename] = imageUrl;
              paraImages += `<img src="${imageUrl}" alt="" width="760" class="adapt-img" style="display:block;margin:14px 0;max-width:100%;height:auto">`;
              hasImage = true;
            } catch (error) {
              console.log(`    ⚠️  Drive upload failed: ${error.message}`);
              paraImages += `<img src="image_${imageCount}.jpg" alt="" width="760" class="adapt-img" style="display:block;margin:14px 0;max-width:100%;height:auto">`;
              hasImage = true;
            }
          }
        }
        
        // Handle text
        if (elem.textRun) {
          let text = elem.textRun.content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          
          // Extract line breaks before processing (preserve them outside formatting tags)
          // Handle both \n (newline) and \v (vertical tab, used by Google Docs for soft breaks)
          const hasLineBreakAtEnd = /[\n\v]$/.test(text);
          const hasLineBreakAtStart = /^[\n\v]/.test(text);
          
          // Remove line breaks temporarily for processing
          text = text.replace(/[\n\v]/g, '');
          text = text.replace(/[ \t]+/g, ' '); // Collapse spaces and tabs
          
          const style = elem.textRun.textStyle || {};
          
          if (!text) {
            // Text run was only line breaks; emit them
            if (hasLineBreakAtStart) paraText += '<br>';
            if (hasLineBreakAtEnd && !hasLineBreakAtStart) paraText += '<br>';
            continue;
          }
          
          if (style.bold) text = `<strong>${text}</strong>`;
          if (style.italic) text = `<em>${text}</em>`;
          if (style.underline && !style.link?.url) text = `<u>${text}</u>`;
          if (style.link?.url) text = `<a href="${style.link.url}" style="${LINK_STYLE}">${text}</a>`;
          
          // Apply color only if not a link (links already have color)
          if (style.foregroundColor?.color?.rgbColor && !style.link?.url) {
            const rgb = style.foregroundColor.color.rgbColor;
            const r = Math.round((rgb.red || 0) * 255);
            const g = Math.round((rgb.green || 0) * 255);
            const b = Math.round((rgb.blue || 0) * 255);
            text = `<span style="color:rgb(${r},${g},${b})">${text}</span>`;
          }
          
          // Add line breaks outside formatting tags
          if (hasLineBreakAtStart) paraText += '<br>';
          paraText += text;
          if (hasLineBreakAtEnd) paraText += '<br>';
        }
      }
    }
    
    // Wrap completed paragraph with Stripo styling
    const namedStyle = para.paragraphStyle?.namedStyleType;
    const bullet = para.bullet; // Check if paragraph is a list item
    let styledContent = '';
    
    // Trim paraText to remove trailing spaces and trailing <br> tags
    paraText = paraText.trim();
    paraText = paraText.replace(/(<br>)+$/g, ''); // Remove trailing <br> tags
    
    // Check if this is actually regular text (not a heading)
    // If it has a lot of text content after a link/short bold text, treat as paragraph
    const hasLinkAtStart = paraText.startsWith('<a href=');
    const textAfterLink = paraText.replace(/<a [^>]*>.*?<\/a>/i, '').replace(/<[^>]+>/g, '').trim();
    const isLikelyParagraph = hasLinkAtStart && textAfterLink.length > 30; // More than 30 chars of regular text
    
    if (!paraText && !hasImage) {
      styledContent = '<br>';
    } else if (bullet) {
      const listType = bullet.listProperties?.listStyleType || 'disc';
      const tag = (listType.includes('decimal') || listType.includes('roman') || listType.includes('alpha')) ? 'ol' : 'ul';
      styledContent = `<${tag} style="padding:0 0 0 25px;margin:0"><li style="margin:0">${paraText}</li></${tag}>`;
    } else if (isLikelyParagraph) {
      styledContent = `<p style="margin:0 0 10px">${paraText}</p>`;
    } else if (namedStyle?.startsWith('HEADING_')) {
      const headingId = para.paragraphStyle?.headingId;
      const idAttr = headingId ? ` id="${headingId}"` : '';
      const n = parseInt(namedStyle.replace('HEADING_', ''));
      const hs = { 1:'font:700 24px/43px arial,sans-serif;margin:24px 0 0', 2:'font:700 22px/33px arial,sans-serif;margin:22px 0 0', 3:'font:700 18px/27px arial,sans-serif;margin:18px 0 0', 4:'font:700 16px/24px arial,sans-serif;margin:16px 0 0', 5:'font:700 14px/28px arial,sans-serif;margin:12px 0 0', 6:'font:700 12px/24px arial,sans-serif;margin:10px 0 0' };
      styledContent = `<h${n}${idAttr} style="${hs[n] || hs[6]};color:#000">${paraText}</h${n}>`;
    } else if (paraText) {
      styledContent = `<p style="margin:0 0 10px">${paraText}</p>`;
    }
    
    // Return images first, then text
    return paraImages + styledContent;
  }
  
  function processTOC(tocElement) {
    const raw = [];
    const content = tocElement.content || [];

    for (const el of content) {
      if (!el.paragraph) continue;
      const para = el.paragraph;
      const indent = para.paragraphStyle?.indentStart?.magnitude || 0;

      let text = '';
      let headingId = '';
      for (const elem of (para.elements || [])) {
        if (elem.textRun) {
          const t = elem.textRun.content.replace(/[\n\v]/g, '').trim();
          if (t) text += t;
          if (!headingId) {
            const link = elem.textRun.textStyle?.link;
            headingId = link?.headingId || link?.heading?.id || '';
          }
        }
      }
      if (text) raw.push({ text, indent, headingId });
    }

    if (raw.length === 0) return '';

    const uniqueIndents = [...new Set(raw.map(e => e.indent))].sort((a, b) => a - b);
    const entries = raw.map(e => ({
      ...e,
      level: uniqueIndents.indexOf(e.indent),
    }));

    console.log(`  📑 TOC: ${entries.length} entries, ${uniqueIndents.length} levels (indents: ${uniqueIndents.join(', ')}pt)`);

    const FONT = "font-family:arial,'helvetica neue',helvetica,sans-serif";
    const levelCfg = [
      { size: '15px', weight: '700', color: '#202124', marker: '', indent: 0, marginTop: '10px' },
      { size: '14px', weight: '500', color: '#3c4043', marker: '&ndash;&nbsp;', indent: 18, marginTop: '3px' },
      { size: '13px', weight: '400', color: '#5f6368', marker: '&middot;&nbsp;', indent: 36, marginTop: '2px' },
      { size: '12px', weight: '400', color: '#80868b', marker: '&middot;&nbsp;', indent: 52, marginTop: '1px' },
    ];

    let html = '\n<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;margin:16px 0"><tr>';
    html += `<td style="background:#f8f9fa;border-left:3px solid #1a73e8;padding:16px 20px;border-radius:0 4px 4px 0;${FONT}">`;
    html += `<p style="margin:0 0 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#5f6368">In this update</p>`;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const cfg = levelCfg[Math.min(entry.level, levelCfg.length - 1)];
      const escaped = entry.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const topPad = i === 0 ? '0' : cfg.marginTop;

      let label;
      if (entry.headingId) {
        label = `<a href="#${entry.headingId}" style="color:${cfg.color};text-decoration:none">${escaped}</a>`;
      } else {
        label = escaped;
      }

      html += `<p style="margin:${topPad} 0 0 ${cfg.indent}px;font:${cfg.weight} ${cfg.size}/22px arial,sans-serif;color:${cfg.color}">${cfg.marker}${label}</p>`;
    }

    html += '</td></tr></table>\n';
    return html;
  }

  // Helper function to recursively process content elements (handles tables)
  async function processContent(elements) {
    for (const el of elements) {
      if (el.tableOfContents) {
        htmlContent += processTOC(el.tableOfContents);
        htmlContent += '\n';
      } else if (el.paragraph) {
        htmlContent += await processParagraph(el.paragraph);
        htmlContent += '\n';
      } else if (el.table) {
        htmlContent += '\n<table cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse">\n';
        
        for (const row of el.table.tableRows || []) {
          htmlContent += '<tr>\n';
          for (const cell of row.tableCells || []) {
            htmlContent += '<td style="padding:10px;border:1px solid #ccc">';
            
            // Process cell content
            if (cell.content) {
              for (const cellEl of cell.content) {
                if (cellEl.paragraph) {
                  const cellContent = await processParagraph(cellEl.paragraph);
                  htmlContent += cellContent;
                }
              }
            }
            
            htmlContent += '</td>\n';
          }
          htmlContent += '</tr>\n';
        }
        
        htmlContent += '</table>\n<br>\n';
      }
    }
  }
  
  // Process all content
  await processContent(tabContent);
  
  console.log(`✓ Processed ${imageCount} images`);
  
  // Normalize spacing, inject job cards from cache, and generate HTML
  htmlContent = normalizeSpacing(htmlContent);
  if (params.jobs && params.jobs.length > 0) {
    htmlContent = injectJobCards(htmlContent, params.jobs);
  }
  const trackDate = date.replace(/-/g, '');
  const html = buildHTML(htmlContent, trackDate, { tabName, formattedDate: date });
  
  const filename = `${tabName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
  const filepath = path.join(folder, filename);
  fs.writeFileSync(filepath, html);
  console.log(`\n✓ Saved: ${filepath}`);
  
  // Create Gmail draft
  console.log('\n📧 Creating Gmail draft...');
  try {
    const subject = `${config.gmailSubjectPrefix} ${date}`;
    
    // Create simple HTML email (images are already hosted URLs)
    const message = [
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html
    ];
    
    const raw = Buffer.from(message.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    
    await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } }
    });
    
    console.log(`✓ Gmail draft created: ${subject}`);
  } catch (error) {
    console.log(`⚠️  Gmail draft failed: ${error.message}`);
    if (error.message.includes('Insufficient Permission')) {
      console.log('   Delete token.json in config (or ~/.config/export_docs_gmail) and run cli.js again to re-authenticate');
    }
  }
  
  console.log('\n✅ Done!');
  console.log(`📁 ${folder}/`);
  console.log(`📄 ${filename}`);
  if (imageCount > 0) console.log(`🖼️  ${imageCount} images`);
}

module.exports = { exportDoc, buildHTML };

if (require.main === module) {
  exportDoc().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  });
}
