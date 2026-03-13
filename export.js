#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const stream = require('stream');
const config = require('./load-config');

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
function normalizeSpacing(html) {
  // Remove every standalone <br> that occupies its own line.
  // Inline <br> (inside a <p>) won't match because they aren't at line start.
  html = html.replace(/^<br>\n/gm, '');

  // When a heading directly follows another heading, collapse the second
  // heading's margin-top to keep heading hierarchies visually tight.
  // Full margin-top only applies after non-heading content (paragraphs, images, etc.).
  html = html.replace(
    /(<\/h[1-6]>\n<h[1-6]\s+style="[^"]*?)margin-top:\d+px/g,
    '$1margin-top:2px'
  );

  return html;
}

// Derive header label and title from gmailSubjectPrefix when not explicitly configured.
// e.g. "[tri-weekly] Observability Update" → label "OBSERVABILITY", title "Tri-Weekly Update"
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

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns="http://www.w3.org/1999/xhtml" lang="en">
 <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="format-detection" content="telephone=no">
  <title>${titleText}</title><!--[if (mso 16)]>
      <style type="text/css">
         a {text-decoration: none;}
      </style>
      <![endif]--><!--[if gte mso 9]>
      <style>sup { font-size: 100% !important; }</style>
      <![endif]--><!--[if gte mso 9]>
      <noscript>
         <xml>
           <o:OfficeDocumentSettings>
           <o:AllowPNG></o:AllowPNG>
           <o:PixelsPerInch>96</o:PixelsPerInch>
           </o:OfficeDocumentSettings>
         </xml>
      </noscript>
      <![endif]--><!--[if mso]><xml>
    <w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word">
      <w:DontUseAdvancedTypographyReadingMail/>
    </w:WordDocument>
    </xml><![endif]-->
  <style type="text/css">.rollover:hover .rollover-first {
  max-height:0px!important;
  display:none!important;
}
.rollover:hover .rollover-second {
  max-height:none!important;
  display:block!important;
}
.rollover span {
  font-size:0px;
}
u + .body img ~ div div {
  display:none;
}
#outlook a {
  padding:0;
}
span.MsoHyperlink,
span.MsoHyperlinkFollowed {
  color:inherit;
  mso-style-priority:99;
}
a.p {
  mso-style-priority:100!important;
  text-decoration:none!important;
}
a[x-apple-data-detectors],
#MessageViewBody a {
  color:inherit!important;
  text-decoration:none!important;
  font-size:inherit!important;
  font-family:inherit!important;
  font-weight:inherit!important;
  line-height:inherit!important;
}
.d {
  display:none;
  float:left;
  overflow:hidden;
  width:0;
  max-height:0;
  line-height:0;
  mso-hide:all;
}
@media only screen and (max-width:600px) {.be { padding-bottom:20px!important }  *[class="gmail-fix"] { display:none!important } p, a { line-height:150%!important } h1, h1 a { line-height:180%!important } h2, h2 a { line-height:150%!important } h3, h3 a { line-height:150%!important } h4, h4 a { line-height:150%!important } h5, h5 a { line-height:150%!important } h6, h6 a { line-height:120%!important }  .bb p { margin-bottom:14px!important } .ba p { }  h1 { font-size:24px!important; text-align:left; margin-bottom:22px!important } h2 { font-size:22px!important; text-align:left; margin-bottom:17px!important } h3 { font-size:18px!important; text-align:left; margin-bottom:14px!important } h4 { font-size:16px!important; text-align:left; margin-bottom:12px!important } h5 { font-size:14px!important; text-align:left; margin-bottom:11px!important } h6 { font-size:16px!important; text-align:left; margin-bottom:10px!important }         .bb p, .bb a { font-size:18px!important } .ba p, .ba a { font-size:14px!important }       .v .rollover:hover .rollover-second, .w .rollover:hover .rollover-second, .x .rollover:hover .rollover-second { display:inline!important }  .u { display:inline-table }     .l table, .m, .n { width:100%!important } .i table, .j table, .k table, .i, .k, .j { width:100%!important; max-width:600px!important } .adapt-img { width:100%!important; height:auto!important }           .h-auto { height:auto!important } }
@media screen and (max-width:384px) {.mail-message-content { width:414px!important } }</style>
 </head>
 <body class="body" style="width:100%;height:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F6F6F6"><!--[if gte mso 9]>
         <v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t">
            <v:fill type="tile" color="#f6f6f6"></v:fill>
         </v:background>
         <![endif]-->
   <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%;background-color:#F6F6F6">
     <tr>
      <td valign="top" style="padding:0;Margin:0">
       <table cellspacing="0" cellpadding="0" align="center" class="j" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="ba" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:800px">
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:24px;padding-right:20px;padding-left:20px">
               <table align="left" cellspacing="0" cellpadding="0" class="m" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;float:left">
                 <tr>
                  <td align="left" style="padding:0;Margin:0;width:760px">
                   <table width="100%" role="presentation" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                     <tr>
                      <td align="center" style="padding:0;Margin:0;font-size:0"><img src="${config.trackerBaseUrl}${trackDate}" alt="" width="128" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:16px 0 0;Margin:0">
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:16px;letter-spacing:1.5px;color:#999999;font-size:11px;text-transform:uppercase">${headerLabel}</p>
                      </td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:10px 0 0;Margin:0">
                       <h1 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:-0.3px;font-size:26px;font-style:normal;font-weight:bold;line-height:34px;color:#222222">${headerTitle}</h1>
                      </td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:10px 0 4px;Margin:0">
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:20px;letter-spacing:0px;color:#999999;font-size:13px">${displayDate}${iterLabel ? ' &middot; ' + iterLabel : ''}</p>
                      </td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
           </table></td>
         </tr>
       </table>
       <table cellspacing="0" cellpadding="0" align="center" class="k" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table bgcolor="#ffffff" align="center" cellspacing="0" cellpadding="0" class="bb" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:800px">
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:12px;padding-right:20px;padding-left:20px">
               <table cellpadding="0" width="100%" cellspacing="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:760px">
                   <table cellspacing="0" cellpadding="0" width="100%" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                     <tr>
                      <td align="center" style="padding:12px 20px;Margin:0;font-size:0">
                       <table width="100%" height="100%" cellpadding="0" cellspacing="0" border="0" class="u" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                         <tr>
                          <td style="padding:0;Margin:0;width:100%;margin:0px;border-bottom:1px solid #e0e0e0;background:none;height:0px"></td>
                         </tr>
                       </table></td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
           </table></td>
         </tr>
       </table>
       <table align="center" cellspacing="0" cellpadding="0" class="i" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;width:100%;table-layout:fixed !important">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table bgcolor="#ffffff" align="center" cellspacing="0" cellpadding="0" class="bb" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:800px">
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-right:20px;padding-left:20px">
               <table cellspacing="0" cellpadding="0" width="100%" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:760px">
                   <table cellpadding="0" width="100%" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                     <tr>
                      <td align="left" style="padding:0;Margin:0">${content}</td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:20px;Margin:0;font-size:0">
                       <table border="0" width="100%" height="100%" cellpadding="0" cellspacing="0" class="u" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                         <tr>
                          <td style="padding:0;Margin:0;margin:0px;border-bottom:1px solid #e0e0e0;background:none;height:0px;width:100%"></td>
                         </tr>
                       </table></td>
                     </tr>
                   </table></td>
                 </tr>
                 <tr>
                  <td align="left" style="padding:0;Margin:0;width:760px">
                   <table cellspacing="0" width="100%" role="none" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px">
                     <tr class="f">
                      <td align="center" height="10" style="padding:0;Margin:0;font-size:0"></td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
           </table></td>
         </tr>
       </table>
       <table cellspacing="0" cellpadding="0" align="center" class="k" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="ba" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;border-spacing:0px;background-color:#FFFFFF;width:800px">
             <tr>
              <td align="center" style="Margin:0;padding-top:12px;padding-right:20px;padding-left:20px;padding-bottom:24px">
               <p style="Margin:0;mso-line-height-rule:exactly;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:18px;letter-spacing:0px;color:#bbbbbb;font-size:12px">Observability Team &mdash; Elastic</p>
              </td>
             </tr>
           </table></td>
         </tr>
       </table></td>
     </tr>
   </table>
  </div>
 </body>
</html>`;
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
            paraText += `<a href="mailto:${email}" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><u>${name || email}</u></a> `;
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
            paraText += `<a href="${url}" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><u>${title}</u></a> `;
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
            
            console.log(`  📥 Downloading & uploading image ${imageCount} to Drive...`);
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            
            // Detect image extension from content-type
            const contentType = response.headers['content-type'] || 'image/jpeg';
            const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
            const filename = `image_${imageCount}.${ext}`;
            
            // Save locally
            fs.writeFileSync(path.join(folder, filename), response.data);
            
            // Upload to Google Drive (override if exists)
            try {
              // Check if file already exists in folder
              const existingFiles = await drive.files.list({
                q: `name='${filename}' and '${driveFolder.data.id}' in parents and trashed=false`,
                fields: 'files(id)',
                spaces: 'drive'
              });
              
              let driveFileId;
              if (existingFiles.data.files && existingFiles.data.files.length > 0) {
                // File exists - skip upload and reuse existing
                driveFileId = existingFiles.data.files[0].id;
                console.log(`    ♻️  Reusing existing file in Drive`);
              } else {
                // Create new file
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
                
                // Make it publicly accessible (only for new files)
                await drive.permissions.create({
                  fileId: driveFileId,
                  requestBody: {
                    role: 'reader',
                    type: 'anyone'
                  }
                });
              }
              
              // Get direct download URL
              const imageUrl = config.getDriveImageUrl(driveFileId);
              uploadedImages[filename] = imageUrl;
              
              // Add to paragraph images instead of global htmlContent
              paraImages += `<img src="${imageUrl}" alt="" width="760" class="adapt-img" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:10px 0">`;
              hasImage = true;
            } catch (error) {
              console.log(`    ⚠️  Drive upload failed: ${error.message}`);
              // Fallback to local reference
              paraImages += `<img src="${filename}" alt="" width="760" class="adapt-img" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:10px 0">`;
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
          
          if (!text || !text.trim()) {
            // If only line breaks, add them directly
            if (hasLineBreakAtStart) paraText += '<br>';
            if (hasLineBreakAtEnd && !hasLineBreakAtStart) paraText += '<br>';
            continue;
          }
          
          if (style.bold) text = `<strong style="font-weight:700 !important">${text}</strong>`;
          if (style.italic) text = `<em>${text}</em>`;
          if (style.underline && !style.link?.url) text = `<u>${text}</u>`;
          if (style.link?.url) text = `<a href="${style.link.url}" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><u>${text}</u></a>`;
          
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
    
    // Handle empty paragraphs as <br>
    if (!paraText && !hasImage) {
      styledContent = '<br>';
    } else if (bullet) {
      // Determine if it's an ordered or unordered list
      const isOrdered = bullet.listId && bullet.nestingLevel !== undefined;
      const listType = bullet.listProperties?.listStyleType || 'disc'; // Check for numbered vs bullet
      
      if (listType.includes('decimal') || listType.includes('roman') || listType.includes('alpha')) {
        // Numbered list (ordered)
        styledContent = `<ol style="font-family:arial,'helvetica neue',helvetica,sans-serif;padding:0px 0px 0px 25px;margin-top:2px;margin-bottom:2px"><li style="color:#333333;margin:0px 0px 0px;font-size:14px"><p style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:21px;letter-spacing:0px;color:#333333;font-size:14px;margin-bottom:2px">${paraText}</p></li></ol>`;
      } else {
        // Bullet list (unordered)
        styledContent = `<ul style="font-family:arial,'helvetica neue',helvetica,sans-serif;padding:0px 0px 0px 25px;margin-top:2px;margin-bottom:2px"><li style="color:#333333;margin:0px 0px 0px;font-size:14px"><p style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:21px;letter-spacing:0px;color:#333333;font-size:14px;margin-bottom:2px">${paraText}</p></li></ul>`;
      }
    } else if (isLikelyParagraph) {
      // Override heading style if it looks like a paragraph (starts with link + has lots of text)
      styledContent = `<p style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:21px;letter-spacing:0px;color:#333333;font-size:14px;margin-bottom:10px">${paraText}</p>`;
    } else if (namedStyle === 'HEADING_1') {
      styledContent = `<h1 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:24px;font-style:normal;font-weight:bold;line-height:43.2px;color:#000000;margin-top:24px;margin-bottom:4px">${paraText}</h1>`;
    } else if (namedStyle === 'HEADING_2') {
      styledContent = `<h2 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:22px;font-style:normal;font-weight:bold;line-height:33px;color:#000000;margin-top:22px;margin-bottom:4px">${paraText}</h2>`;
    } else if (namedStyle === 'HEADING_3') {
      styledContent = `<h3 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:18px;font-style:normal;font-weight:bold;line-height:27px;color:#000000;margin-top:18px;margin-bottom:4px">${paraText}</h3>`;
    } else if (namedStyle === 'HEADING_4') {
      styledContent = `<h4 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:16px;font-style:normal;font-weight:bold;line-height:24px;color:#000000;margin-top:16px;margin-bottom:4px">${paraText}</h4>`;
    } else if (namedStyle === 'HEADING_5') {
      styledContent = `<h5 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:14px;font-style:normal;font-weight:bold;line-height:28px;color:#000000;margin-top:12px;margin-bottom:4px">${paraText}</h5>`;
    } else if (namedStyle === 'HEADING_6') {
      styledContent = `<h6 style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;letter-spacing:0px;font-size:12px;font-style:normal;font-weight:bold;line-height:24px;color:#000000;margin-top:10px;margin-bottom:4px">${paraText}</h6>`;
    } else if (paraText) {
      styledContent = `<p style="Margin:0;font-family:arial,'helvetica neue',helvetica,sans-serif;line-height:21px;letter-spacing:0px;color:#333333;font-size:14px;margin-bottom:10px">${paraText}</p>`;
    }
    
    // Return images first, then text
    return paraImages + styledContent;
  }
  
  // Helper function to recursively process content elements (handles tables)
  async function processContent(elements) {
    for (const el of elements) {
      if (el.paragraph) {
        htmlContent += await processParagraph(el.paragraph);
        htmlContent += '\n';
      } else if (el.table) {
        // Generate proper table HTML
        htmlContent += '\n<table cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt">\n';
        
        for (const row of el.table.tableRows || []) {
          htmlContent += '<tr>\n';
          for (const cell of row.tableCells || []) {
            htmlContent += '<td style="padding:10px;border:1px solid #cccccc;font-family:arial,\'helvetica neue\',helvetica,sans-serif;font-size:14px;color:#333333;line-height:21px">';
            
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
  
  // Normalize spacing and generate HTML
  htmlContent = normalizeSpacing(htmlContent);
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
