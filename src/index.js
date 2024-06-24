import { nanoid } from "nanoid";

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  await cleanUpExpiredFiles();

  if (request.method === 'POST' && pathname === '/upload') {
    return handleUpload(request);
  }

  if (request.method === 'GET' && pathname.startsWith('/download/')) {
    const filename = pathname.replace('/download/', '');
    return handleDownload(filename);
  }

  if (request.method === 'DELETE' && pathname.startsWith('/delete/')) {
    const filename = pathname.replace('/delete/', '');
    return handleDelete(filename);
  }

  return new Response('Not Found', { status: 404 });
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

  // Password protection
  const password = request.headers.get('X-Custom-Auth-Key');
  if (password !== `Bearer ${AUTH_KEY_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) {
    return new Response('Bad Request', { status: 400 });
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
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleDownload(hash) {
  const indexData = await CDN_BUCKET.get('tempupload/index.json');
  if (!indexData) {
    return new Response('Not Found', { status: 404 });
  }

  const index = await indexData.json();
  const fileRecord = index.find(file => file.hash === hash);
  if (!fileRecord) {
    return new Response('Not Found', { status: 404 });
  }

  const file = await CDN_BUCKET.get(`tempupload/content/${hash}`);
  if (!file) {
    return new Response('Not Found', { status: 404 });
  }

  const response = new Response(file.body, {
    headers: {
      'Content-Type': fileRecord.contentType,
      'Content-Disposition': `inline; filename="${fileRecord.originalName}"`,
    },
  });

  return response;
}

async function handleDelete(filename) {

  // Password protection
  const password = request.headers.get('X-Custom-Auth-Key');
  if (password !== `Bearer ${AUTH_KEY_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const indexData = await CDN_BUCKET.get('tempupload/index.json');
  if (!indexData) {
    return new Response('Not Found', { status: 404 });
  }

  let index = await indexData.json();
  const fileRecord = index.find(file => file.originalName === filename);
  if (!fileRecord) {
    return new Response('Not Found', { status: 404 });
  }

  await CDN_BUCKET.delete(`tempupload/content/${fileRecord.hash}`);
  index = index.filter(file => file.originalName !== filename);

  await CDN_BUCKET.put('tempupload/index.json', JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json' },
  });

  return new Response('File deleted', { status: 200 });
}
