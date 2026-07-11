import fs from 'fs';

async function testUpload() {
  const form = new FormData();
  form.append('key', '6d207e02198a847aa98d0a2a901485a5');
  form.append('action', 'upload');
  
  // Create a dummy 1x1 png image
  const imgBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const blob = new Blob([imgBuffer], { type: 'image/png' });
  form.append('source', blob, 'test.png');

  try {
    const res = await fetch('https://freeimage.host/api/1/upload', {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    console.log(data);
  } catch(e) {
    console.error(e);
  }
}
testUpload();
