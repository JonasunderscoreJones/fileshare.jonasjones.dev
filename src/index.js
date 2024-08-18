import { nanoid } from "nanoid";

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event));
});

const headersCORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-Custom-Auth-Key',
};

async function recordRequest(request) {

  const analyticsData = {
    timestamp: Date.now(),
    domain: new URL(request.url).hostname,
    method: request.method,
    path: new URL(request.url).pathname,
    ipcountry: request.cf.country,
  }
  const ANALYTICS_URL = 'https://analytics.jonasjones.dev/requests/record';

  const response = await fetch(ANALYTICS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': ANALYTICS_API_KEY,
    },
    body: JSON.stringify(analyticsData)
  });

  if (response.ok) {
    console.log('Request recorded successfully');
  } else {
    console.error('Failed to record request:', response.status, await response.text());
  }
}

async function handleRequest(event) {
  const request = event.request;
  event.waitUntil(recordRequest(request));
  const url = new URL(request.url);
  const { pathname } = url;

  await cleanUpExpiredFiles();

  if (request.method === 'OPTIONS') {
    // Handle CORS preflight request
    return new Response(null, {
      status: 204,
      headers: headersCORS
    });
  }

  if (request.method === 'POST' && pathname === '/upload') {
    return handleUpload(request);
  }

  if (request.method === 'POST' && pathname === '/upload-url') {
    return handleUrlUpload(request);
  }

  if (request.method === 'GET' && pathname.startsWith('/download/')) {
    const filename = pathname.replace('/download/', '');
    return handleDownload(filename);
  }

  if (request.method === 'DELETE' && pathname.startsWith('/delete/')) {
    const filename = pathname.replace('/delete/', '');
    return handleDelete(request);
  }

  if (request.method === 'GET' && pathname === '/favicon.ico') {
    return await fetch('https://cdn.jonasjones.dev/tempupload/fileshare.ico');
  }

  if (request.method === 'GET' && pathname === '/') {
    return new Response(htmlForm, {
      headers: { 'content-type': 'text/html;charset=UTF-8', ...headersCORS },
    });
  }

  return new Response('Not Found', { status: 404, headers: headersCORS });
}

async function handleUrlUpload(request) {
  const { url, authKey } = await request.json();
  if (!url || !authKey) {
    return new Response('Bad Request', { status: 400, headers: headersCORS });
  }

  if (authKey !== `Bearer ${AUTH_KEY_SECRET}`) {
    return new Response('Unauthorized', { status: 401, headers: headersCORS });
  }

  try {
    const fileResponse = await fetch(url);
    if (!fileResponse.ok) {
      throw new Error('Failed to fetch the file');
    }

    const fileBlob = await fileResponse.blob();
    const hash = nanoid();
    const contentType = fileResponse.headers.get('Content-Type') || 'application/octet-stream';
    const originalName = url.split('/').pop();
    const deletionTimestamp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    await CDN_BUCKET.put(`tempupload/content/${hash}`, fileBlob.stream(), {
      httpMetadata: { contentType },
    });

    const indexData = await CDN_BUCKET.get('tempupload/index.json');
    const index = indexData ? await indexData.json() : [];

    index.push({
      hash,
      contentType,
      originalName,
      deletionTimestamp,
    });

    await CDN_BUCKET.put('tempupload/index.json', JSON.stringify(index), {
      httpMetadata: { contentType: 'application/json' },
    });

    return new Response(JSON.stringify({ downloadLink: `https://fileshare.jonasjones.dev/download/${hash}` }), {
      headers: { 'Content-Type': 'application/json', ...headersCORS },
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500, headers: headersCORS });
  }
}

async function cleanUpExpiredFiles() {
  const indexData = await CDN_BUCKET.get('/tempupload/index.json');
  if (!indexData) {
    return;
  }

  let index = await indexData.json();
  const now = Date.now();
  const updatedIndex = [];

  for (const fileRecord of index) {
    if (fileRecord.deletionTimestamp <= now) {
      await CDN_BUCKET.delete(`/tempupload/content/${fileRecord.hash}`);
    } else {
      updatedIndex.push(fileRecord);
    }
  }

  if (updatedIndex.length !== index.length) {
    await CDN_BUCKET.put('/tempupload/index.json', JSON.stringify(updatedIndex), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
}

async function handleUpload(request) {
  const password = request.headers.get('X-Custom-Auth-Key');
  if (password !== `Bearer ${AUTH_KEY_SECRET}`) {
    return new Response('Unauthorized', { status: 401, headers: headersCORS });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) {
    return new Response('Bad Request', { status: 400, headers: headersCORS });
  }

  const hash = nanoid();
  const contentType = file.type;
  const originalName = file.name;
  const deletionTimestamp = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  await CDN_BUCKET.put(`tempupload/content/${hash}`, file.stream(), {
    httpMetadata: { contentType },
  });

  const indexData = await CDN_BUCKET.get('tempupload/index.json');
  const index = indexData ? await indexData.json() : [];

  index.push({
    hash,
    contentType,
    originalName,
    deletionTimestamp,
  });

  await CDN_BUCKET.put('tempupload/index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' },
  });

  return new Response(JSON.stringify({ downloadLink: `https://fileshare.jonasjones.dev/download/${hash}` }), {
    headers: { 'Content-Type': 'application/json', ...headersCORS },
  });
}

async function handleDownload(hash) {
  const indexData = await CDN_BUCKET.get('tempupload/index.json');
  if (!indexData) {
    return new Response('Not Found', { status: 404, headers: headersCORS });
  }

  const index = await indexData.json();
  const fileRecord = index.find(file => file.hash === hash);
  if (!fileRecord) {
    return new Response('Not Found', { status: 404, headers: headersCORS });
  }

  const file = await CDN_BUCKET.get(`tempupload/content/${hash}`);
  if (!file) {
    return new Response('Not Found', { status: 404, headers: headersCORS });
  }

  const response = new Response(file.body, {
    headers: {
      'Content-Type': fileRecord.contentType,
      'Content-Disposition': `inline; filename="${fileRecord.originalName}"`,
      ...headersCORS,
    },
  });

  return response;
}

async function handleDelete(request) {
  const url = new URL(request.url);
  const filehash = url.pathname.replace('/delete/', '');

  const password = request.headers.get('X-Custom-Auth-Key');
  if (password !== `Bearer ${AUTH_KEY_SECRET}`) {
    return new Response('Unauthorized', { status: 401, headers: headersCORS });
  }

  const indexData = await CDN_BUCKET.get('tempupload/index.json');
  if (await !indexData) {
    return new Response('Not Found', { status: 404, headers: headersCORS });
  }

  let index = await indexData.json();
  const fileRecord = index.find(file => file.hash === filehash);
  if (!fileRecord) {
    return new Response('Not Found', { status: 404, headers: headersCORS });
  }

  await CDN_BUCKET.delete(`tempupload/content/${fileRecord.hash}`);
  index = index.filter(file => file.hash !== filehash);

  await CDN_BUCKET.put('tempupload/index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' },
  });

  return new Response('File deleted', { status: 200, headers: headersCORS });
}

const htmlForm = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>File Upload and Delete</title>
  <style>
    #deleteForm select {
      width: 100%;
    }
    #deleteForm option {
      padding: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th {
      background-color: #f2f2f2;
    }
  </style>
</head>
<body>
  <h1>Upload a File</h1>
  <form id="uploadForm">
    <input type="file" id="fileInput" name="file" required>
    <input type="password" id="authKey" placeholder="Enter password" required>
    <button type="submit">Upload</button>
  </form>
  <div id="uploadResponse"></div>

  <h1>Upload from URL</h1>
  <form id="urlUploadForm">
    <input type="url" id="fileUrl" placeholder="Enter file URL" required>
    <input type="password" id="urlAuthKey" placeholder="Enter password" required>
    <button type="submit">Upload</button>
  </form>
  <div id="urlUploadResponse"></div>

  <h1>Delete a File</h1>
  <form id="deleteForm">
    <select id="fileSelect" required>
      <option value="">Select a file to delete</option>
    </select>
    <input type="password" id="deleteAuthKey" placeholder="Enter password" required>
    <button type="submit">Delete</button>
  </form>
  <div id="deleteResponse"></div>

  <h1>All Files</h1>
  <table id="fileTable">
    <thead>
      <tr>
        <th>Original Name</th>
        <th>Deletion Timestamp</th>
        <th>Download Link (Hash)</th>
      </tr>
    </thead>
    <tbody id="fileTableBody"></tbody>
  </table>

  <script>
    document.getElementById('uploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const fileInput = document.getElementById('fileInput');
      const authKey = document.getElementById('authKey').value;
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);

      const responseElement = document.getElementById('uploadResponse');
      responseElement.textContent = 'Uploading...';

      try {
        const response = await fetch('https://fileshare.jonasjones.dev/upload', {
          method: 'POST',
          headers: {
            'X-Custom-Auth-Key': \`Bearer \${authKey}\`
          },
          body: formData
        });

        const result = await response.json();
        responseElement.textContent = \`Download Link: \${result.downloadLink}\`;
        fetchFileList();
        fetchFileTable();
      } catch (error) {
        responseElement.textContent = \`Error: \${error.message}\`;
      }
    });

    document.getElementById('urlUploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const fileUrl = document.getElementById('fileUrl').value;
      const authKey = document.getElementById('urlAuthKey').value;
      const responseElement = document.getElementById('urlUploadResponse');
      responseElement.textContent = 'Downloading and uploading...';

      try {
        const response = await fetch('https://fileshare.jonasjones.dev/upload-url', {
          method: 'POST',
          headers: {
            'X-Custom-Auth-Key': \`Bearer \${authKey}\`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ url: fileUrl, authKey: \`Bearer \${authKey}\` })
        });

        const result = await response.json();
        responseElement.textContent = \`Download Link: \${result.downloadLink}\`;
        fetchFileList();
        fetchFileTable();
      } catch (error) {
        responseElement.textContent = \`Error: \${error.message}\`;
      }
    });

    document.getElementById('deleteForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const fileSelect = document.getElementById('fileSelect');
      const fileHash = fileSelect.value;
      const authKey = document.getElementById('deleteAuthKey').value;

      const responseElement = document.getElementById('deleteResponse');
      responseElement.textContent = 'Deleting...';

      try {
        const response = await fetch(\`https://fileshare.jonasjones.dev/delete/\${fileHash}\`, {
          method: 'DELETE',
          headers: {
            'X-Custom-Auth-Key': \`Bearer \${authKey}\`
          }
        });

        const result = await response.json();
        responseElement.textContent = result.message || 'File deleted successfully';
        fetchFileList();
        fetchFileTable();
      } catch (error) {
        responseElement.textContent = \`Error: \${error.message}\`;
      }
    });

    async function fetchFileList() {
      try {
        const response = await fetch('https://cdn.jonasjones.dev/tempupload/index.json');
        const files = await response.json();
        const fileSelect = document.getElementById('fileSelect');
        fileSelect.innerHTML = '<option value="">Select a file to delete</option>';
        files.forEach(file => {
          const option = document.createElement('option');
          const deletionDate = new Date(file.deletionTimestamp).toLocaleString();
          option.value = file.hash;
          option.textContent = \`\${file.originalName} (deletes on \${deletionDate}) - \${file.hash}\`;
          fileSelect.appendChild(option);
        });
      } catch (error) {
        console.error('Error fetching file list:', error);
      }
    }

    async function fetchFileTable() {
      try {
        const response = await fetch('https://cdn.jonasjones.dev/tempupload/index.json');
        const files = await response.json();
        const fileTableBody = document.getElementById('fileTableBody');
        fileTableBody.innerHTML = '';
        files.forEach(file => {
          const row = document.createElement('tr');
          const deletionDate = new Date(file.deletionTimestamp).toLocaleString();
          row.innerHTML = \`
            <td>\${file.originalName}</td>
            <td>\${deletionDate}</td>
            <td><a href="https://fileshare.jonasjones.dev/download/\${file.hash}">\${file.hash}</a></td>
          \`;
          fileTableBody.appendChild(row);
        });
      } catch (error) {
        console.error('Error fetching file list for table:', error);
      }
    }

    fetchFileList();
    fetchFileTable();
  </script>
</body>
</html>
`;
