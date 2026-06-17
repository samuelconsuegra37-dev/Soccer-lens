console.log('Soccer Lens background script loaded!');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'IDENTIFY_PLAYER') {
    const byteString = atob(message.base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: 'image/jpeg' });
    
    const formData = new FormData();
    formData.append('file', blob, 'frame.jpg');

    fetch('http://localhost:8000/identify', {
      method: 'POST',
      body: formData
    })
    .then(r => r.json())
    .then(data => sendResponse(data))
    .catch(err => sendResponse({error: err.message}));
    
    return true;
  }

  if (message.type === 'GET_NARRATIVE') {
    fetch(`http://localhost:8000/profile/${encodeURIComponent(message.playerName)}`)
    .then(r => r.json())
    .then(data => sendResponse(data))
    .catch(err => sendResponse({error: err.message}));
    return true;
  }
});