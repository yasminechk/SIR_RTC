// === Rôles et métadonnées ===
let offerCallback = null;
const remoteMetadata = new Map();
const localMetadata = {};

const useTrickleIce = true;
const initialHash = window.location.hash.substr(1);
// La machine qui ouvre un lien AVEC #id est celle qui partage
const isSender = initialHash.length > 0;

let screenShare;
let placeholderTrack;
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const peers = new Map();
let clientId;
let ws;
let localStream;
let iceServers = null;

// DOM
const shareBtn = document.getElementById('shareBtn');
const hangupBtn = document.getElementById('hangupButton');
const bandwidthSelector = document.querySelector('select#bandwidth');
const connectionState = document.getElementById('connectionState');
const roleInfo = document.getElementById('roleInfo');
const linkInfo = document.getElementById('linkInfo');
const clientIdSpan = document.getElementById('clientId');
const peerIdSpan = document.getElementById('peerId'); // pas obligatoire
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const fullscreenBtn = document.getElementById('fullscreenBtn');

// Texte de rôle
if (roleInfo) {
  if (isSender) {
    roleInfo.textContent =
      "Vous avez ouvert un lien reçu : c’est votre écran qui sera partagé.";
  } else {
    roleInfo.textContent =
      "Vous êtes l’initiateur : envoyez le lien affiché ci-dessous à la personne qui doit partager son écran.";
  }
}

// L’initiateur (sans hash) ne partage pas
if (!isSender && shareBtn) {
  shareBtn.style.display = 'none';
}

// Plein écran sur la vidéo distante
if (fullscreenBtn && remoteVideo) {
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      remoteVideo.requestFullscreen().catch(err => {
        console.warn('Fullscreen failed', err);
      });
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

// === Placeholder vidéo ===
function setLocalMetadataLabel(label) {
  Object.keys(localMetadata).forEach(k => delete localMetadata[k]);
  if (localStream) {
    localMetadata[localStream.id] = label;
  }
}

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
    promises.push(
      sender.replaceTrack(trackToUse).catch(e => console.error('replaceTrack failed', e))
    );
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
      setLocalMetadataLabel('placeholder');
      if (localVideo) localVideo.srcObject = localStream;
      replaceVideoTrack(null);
      shareBtn.classList.remove('sharing');
      shareBtn.textContent = 'Partager mon écran';
      return;
    }

    // Démarrer partage d’écran
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      localStream = new MediaStream([track]);
      setLocalMetadataLabel('screen-share');
      await replaceVideoTrack(track);
      if (localVideo) localVideo.srcObject = stream;

      track.addEventListener('ended', () => {
        console.log('Screensharing ended via browser UI');
        screenShare = null;
        const placeholder = ensurePlaceholderTrack();
        localStream = new MediaStream([placeholder]);
        setLocalMetadataLabel('placeholder');
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
  peers.forEach((pc, id) => {
    hangup(id);
  });
});

// === Bande passante ===
bandwidthSelector.onchange = () => {
  bandwidthSelector.disabled = true;
  const bandwidth = bandwidthSelector.options[bandwidthSelector.selectedIndex].value;
  if (!('RTCRtpSender' in window && 'setParameters' in window.RTCRtpSender.prototype)) {
    return;
  }
  peers.forEach((pc) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings) parameters.encodings = [{}];

    if (bandwidth === 'unlimited') {
      delete parameters.encodings[0].maxBitrate;
    } else {
      parameters.encodings[0].maxBitrate = bandwidth * 1000;
    }
    sender.setParameters(parameters)
      .then(() => {
        bandwidthSelector.disabled = false;
      })
      .catch(e => console.error(e));
  });
};

// === getUserMedia local (placeholder) ===
async function getUserMedia() {
  const track = ensurePlaceholderTrack();
  const stream = new MediaStream([track]);
  localStream = stream;
  if (localVideo) localVideo.srcObject = stream;
  setLocalMetadataLabel('placeholder');
  return stream;
}

// === WebSocket / signalisation ===
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(protocol + '://' + window.location.host);
    ws.addEventListener('open', () => {
      console.log('websocket opened');
    });
    ws.addEventListener('error', (e) => {
      console.log('websocket error, is the server running?', e);
      reject(e);
    });
    ws.addEventListener('close', (e) => {
      console.log('websocket closed', e);
    });
    ws.addEventListener('message', async (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        console.log('Received invalid JSON', err, e.data);
        return;
      }
      console.log('WS message type:', data.type, 'from', data.id);

      switch (data.type) {
        case 'hello':
          clientId = data.id;
          if (clientIdSpan) clientIdSpan.innerText = clientId;
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
        case 'bye':
          if (peers.has(data.id)) {
            peers.get(data.id).close();
            peers.delete(data.id);
            remoteMetadata.delete(data.id);
          }
          break;
        case 'offer':
          if (!peers.has(data.id)) {
            console.log('Incoming call from', data.id);
            if (peerIdSpan) peerIdSpan.innerText = data.id;
            if (peers.size >= 1) {
              ws.send(JSON.stringify({ type: 'bye', id: data.id }));
              return;
            }
            remoteMetadata.set(data.id, data.metadata);
            const pc = createPeerConnection(data.id);
            if (localStream) {
              localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
            }
            await pc.setRemoteDescription({
              type: data.type,
              sdp: data.sdp
            });

            if (!offerCallback) {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              if (useTrickleIce) {
                ws.send(JSON.stringify({
                  type: 'answer',
                  sdp: answer.sdp,
                  id: data.id,
                  metadata: localMetadata,
                }));
              }
            } else {
              offerCallback(data.id);
            }
            hangupBtn.disabled = false;
          }
          break;
        case 'answer':
          if (peers.has(data.id)) {
            remoteMetadata.set(data.id, data.metadata);
            const pc = peers.get(data.id);
            await pc.setRemoteDescription({
              type: data.type,
              sdp: data.sdp
            });
          }
          break;
        case 'candidate':
          if (peers.has(data.id)) {
            const pc = peers.get(data.id);
            await pc.addIceCandidate(data.candidate);
          }
          break;
        default:
          console.log('Unhandled', data);
          break;
      }
    });
  });
}

function createPeerConnection(id) {
  const pc = new RTCPeerConnection({ iceServers });
  let signalledCandidates = false;

  pc.addEventListener('icecandidate', (e) => {
    const { candidate } = e;
    if (useTrickleIce) {
      ws.send(JSON.stringify({
        type: 'candidate',
        candidate,
        id,
      }));
    } else if (!signalledCandidates) {
      if (!candidate || candidate.type === 'relay') {
        signalledCandidates = true;
        ws.send(JSON.stringify({
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
          id,
          metadata: localMetadata,
        }));
      }
    }
  });

  pc.addEventListener('track', (e) => {
    if (!remoteVideo) return;
    const remoteStream = e.streams[0];
    console.log(id, 'received remote track(s)', remoteStream.getTracks().map(t => ({
      kind: t.kind,
      readyState: t.readyState
    })));
    remoteVideo.muted = true;
    remoteVideo.srcObject = remoteStream;
    if (typeof remoteVideo.play === 'function') {
      remoteVideo.play().catch(err => console.warn('remoteVideo.play() failed', err));
    }
    if (connectionState) {
      connectionState.style.display = 'block';
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    console.log(id, 'connectionstatechange', pc.connectionState);
    if (pc.connectionState === 'connected') {
      hangupBtn.disabled = false;
      if (screenShare) {
        const track = screenShare.getVideoTracks()[0];
        if (track) {
          replaceVideoTrack(track).catch(e =>
            console.error('Failed to sync screenShare track', e)
          );
        }
      }
    }
  });

  peers.set(id, pc);
  return pc;
}

async function call(id) {
  if (peers.has(id)) {
    console.log('Already in a call with', id);
    return;
  }
  const pc = createPeerConnection(id);
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (useTrickleIce) {
    ws.send(JSON.stringify({
      type: 'offer',
      sdp: offer.sdp,
      id,
      metadata: localMetadata,
    }));
  }
  hangupBtn.disabled = false;
  if (peerIdSpan) peerIdSpan.innerText = id;
}

async function answer(id) {
  if (!peers.has(id)) return;
  const pc = peers.get(id);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (useTrickleIce) {
    ws.send(JSON.stringify({
      type: 'answer',
      sdp: answer.sdp,
      id,
      metadata: localMetadata,
    }));
  }
  hangupBtn.disabled = false;
}

function hangup(id) {
  if (!peers.has(id)) return;
  const pc = peers.get(id);
  pc.close();
  peers.delete(id);
  ws.send(JSON.stringify({ type: 'bye', id }));
}

window.addEventListener('beforeunload', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    peers.forEach((pc, id) => {
      hangup(id);
    });
  }
});

// === Initialisation ===
getUserMedia()
  .then(() => connect())
  .then(() => {
    // Si je suis la personne qui a reçu un lien avec #id, j’appelle l’initiateur
    if (isSender && initialHash.length) {
      call(initialHash);
    }
  })
  .catch(err => console.error('Failed to initialize', err));
