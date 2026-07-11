import fs from 'fs';

async function testUpload() {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  
  // Create a dummy 1x1 png image
  const imgBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const blob = new Blob([imgBuffer], { type: 'image/png' });
  form.append('fileToUpload', blob, 'test.png');

  try {
    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: form
    });
    const data = await res.text();
    console.log("Catbox URL:", data);
  } catch(e) {
    console.error(e);
  }
}
testUpload();
