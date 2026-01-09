// === Rôles simples ===
const initialHash = window.location.hash.substr(1);
const isSender = initialHash.length > 0;  // avec #id => partageur

const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const peers = new Map();
let ws;
let clientId;
let localStream;
let screenShare = null;
let placeholderTrack = null;
let iceServers = null;

// DOM
const shareBtn = document.getElementById('shareBtn');
const hangupBtn = document.getElementById('hangupButton');
const bandwidthSelector = document.getElementById('bandwidth');
const connectionState = document.getElementById('connectionState');
const roleInfo = document.getElementById('roleInfo');
const linkInfo = document.getElementById('linkInfo');
const clientIdSpan = document.getElementById('clientId');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// Texte de rôle
if (roleInfo) {
  roleInfo.textContent = isSender
    ? "Vous avez ouvert un lien reçu : c’est votre écran qui sera partagé."
    : "Vous êtes l’initiateur : envoyez le lien affiché ci-dessous à la personne qui doit partager son écran.";
}

// Initiateur ne partage pas
if (!isSender && shareBtn) {
  shareBtn.style.display = 'none';
}

// Plein écran
if (fullscreenBtn && remoteVideo) {
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      // Demander le plein écran sur la vidéo
      remoteVideo.requestFullscreen?.()
        .catch(err => console.warn('Fullscreen failed', err));
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });
}


// === Placeholder ===
function ensurePlaceholderTrack() {
  if (!placeholderTrack) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText('En attente de partage d’écran…', 40, canvas.height / 2);
    const stream = canvas.captureStream(1);
    placeholderTrack = stream.getVideoTracks()[0];
  }
  return placeholderTrack;
}

// === Flux local initial ===
async function getUserMediaPlaceholder() {
  const track = ensurePlaceholderTrack();
  const stream = new MediaStream([track]);
  localStream = stream;
  if (localVideo) localVideo.srcObject = stream;
  return stream;
}

// === Remplacement du track vidéo ===
async function replaceVideoTrack(withTrack) {
  const trackToUse = withTrack || ensurePlaceholderTrack();
  const promises = [];
  peers.forEach(pc => {
    let sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) {
      try {
        sender = pc.addTrack(trackToUse, localStream || new MediaStream([trackToUse]));
      } catch (err) {
        console.error('Failed to add track', err);
        return;
      }
    }
    promises.push(sender.replaceTrack(trackToUse).catch(e => console.error('replaceTrack failed', e)));
  });
  await Promise.all(promises);
}

// === Bouton Partager ===
if (shareBtn) {
  shareBtn.addEventListener('click', async () => {
    if (screenShare) {
      // Stop partage
      screenShare.getTracks().forEach(t => t.stop());
      screenShare = null;
      const placeholder = ensurePlaceholderTrack();
      localStream = new MediaStream([placeholder]);
      if (localVideo) localVideo.srcObject = localStream;
      replaceVideoTrack(null);
      shareBtn.classList.remove('sharing');
      shareBtn.textContent = 'Partager mon écran';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      localStream = new MediaStream([track]);
      if (localVideo) localVideo.srcObject = stream;
      await replaceVideoTrack(track);

      track.addEventListener('ended', () => {
        console.log('Screensharing ended via browser UI');
        screenShare = null;
        const placeholder = ensurePlaceholderTrack();
        localStream = new MediaStream([placeholder]);
        if (localVideo) localVideo.srcObject = localStream;
        replaceVideoTrack(null);
        shareBtn.classList.remove('sharing');
        shareBtn.textContent = 'Partager mon écran';
      });

      screenShare = stream;
      shareBtn.classList.add('sharing');
      shareBtn.textContent = 'Arrêter le partage';
    } catch (e) {
      console.error('getDisplayMedia failed', e);
    }
  });
}

// === Bouton hangup ===
hangupBtn.addEventListener('click', () => {
  hangupBtn.disabled = true;
  peers.forEach((pc, id) => hangup(id));
});

// === Limite de débit ===
bandwidthSelector.addEventListener('change', () => {
  bandwidthSelector.disabled = true;
  const val = bandwidthSelector.value;
  if (!('RTCRtpSender' in window && 'setParameters' in RTCRtpSender.prototype)) return;

  peers.forEach(pc => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];

    if (val === 'unlimited') {
      delete params.encodings[0].maxBitrate;
    } else {
      params.encodings[0].maxBitrate = parseInt(val, 10) * 1000;
    }
    sender.setParameters(params)
      .catch(e => console.error(e))
      .finally(() => { bandwidthSelector.disabled = false; });
  });
});

// === WebSocket / signalisation ===
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(protocol + '://' + window.location.host);

    ws.addEventListener('open', () => {
      console.log('websocket opened');
    });

    ws.addEventListener('error', (e) => {
      console.log('websocket error', e);
      reject(e);
    });

    ws.addEventListener('close', () => {
      console.log('websocket closed');
    });

    ws.addEventListener('message', async (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }

      switch (data.type) {
        case 'hello':
          clientId = data.id;
          if (clientIdSpan) clientIdSpan.textContent = clientId;
          if (!isSender && linkInfo) {
            const url = window.location.origin + '/#' + clientId;
            linkInfo.textContent =
              "Copiez ce lien et envoyez-le à la personne qui doit partager son écran : " + url;
          }
          break;
        case 'iceServers':
          iceServers = data.iceServers;
          resolve();
          break;
        case 'offer':
          await handleOffer(data);
          break;
        case 'answer':
          await handleAnswer(data);
          break;
        case 'candidate':
          await handleCandidate(data);
          break;
        case 'bye':
          if (peers.has(data.id)) {
            peers.get(data.id).close();
            peers.delete(data.id);
          }
          break;
      }
    });
  });
}

function createPeerConnection(id) {
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(id, pc);

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({
        type: 'candidate',
        candidate: e.candidate,
        id,
      }));
    }
  });

  pc.addEventListener('track', (e) => {
  if (!remoteVideo) return;
  const remoteStream = e.streams[0];
  remoteVideo.muted = true;
  remoteVideo.srcObject = remoteStream;
  remoteVideo.play().catch(err => console.warn('remoteVideo.play() failed', err));
  if (connectionState) {
    connectionState.style.display = 'block';
  }

  // Passage automatique en plein écran à la première frame
  if (!document.fullscreenElement && remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen().catch(err => {
      console.warn('Auto fullscreen refused by browser', err);
    });
  }
});


  pc.addEventListener('connectionstatechange', () => {
    console.log(id, 'connectionstatechange', pc.connectionState);
    if (pc.connectionState === 'connected') {
      hangupBtn.disabled = false;
      if (screenShare) {
        const track = screenShare.getVideoTracks()[0];
        if (track) replaceVideoTrack(track).catch(console.error);
      }
    }
  });

  return pc;
}

async function handleOffer(data) {
  if (peers.has(data.id)) return;
  const pc = createPeerConnection(data.id);
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({
    type: 'answer',
    sdp: answer.sdp,
    id: data.id,
  }));
}

async function handleAnswer(data) {
  const pc = peers.get(data.id);
  if (!pc) return;
  await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

async function handleCandidate(data) {
  const pc = peers.get(data.id);
  if (!pc) return;
  await pc.addIceCandidate(data.candidate);
}

async function call(id) {
  if (peers.has(id)) return;
  const pc = createPeerConnection(id);
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({
    type: 'offer',
    sdp: offer.sdp,
    id,
  }));
}

function hangup(id) {
  const pc = peers.get(id);
  if (!pc) return;
  pc.close();
  peers.delete(id);
  ws.send(JSON.stringify({ type: 'bye', id }));
}

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    peers.forEach((pc, id) => hangup(id));
  }
});

// === Initialisation ===
getUserMediaPlaceholder()
  .then(() => connect())
  .then(() => {
    if (isSender && initialHash.length) {
      call(initialHash);
    }
  })
  .catch(err => console.error('Failed to initialize', err));
