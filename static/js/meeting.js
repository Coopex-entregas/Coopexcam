(() => {
  const root = document.querySelector('[data-join-token]');
  if (!root) return;
  const role = root.dataset.role;
  const joinToken = root.dataset.joinToken;
  const roomCode = root.dataset.roomCode;
  const myParticipantId = Number(root.dataset.participantId || 0);
  const socket = io({ transports: ['polling'] });
  const peers = {};
  const remoteStreams = {};
  let myId = myParticipantId;
  let localStream = null;
  let currentState = window.__INITIAL_STATE__ || {participants: []};
  let micEnabled = true;
  let camEnabled = true;

  const selectedVideo = document.getElementById('selectedVideo');
  const stageEmpty = document.getElementById('stageEmpty');
  const videoGrid = document.getElementById('videoGrid');
  const participantsList = document.getElementById('participantsList');
  const voteBox = document.getElementById('voteBox');

  function api(url, method = 'POST', body = null) {
    return fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : null }).then(r => r.json());
  }

  async function startMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      attachTile({ id: myId || -1, name: 'Você', stream: localStream, isLocal: true });
      promoteStream(localStream, 'Você');
      setupAudioLevel(localStream);
      return true;
    } catch (e) {
      console.error(e);
      if (stageEmpty) stageEmpty.textContent = 'Permita câmera e microfone';
      return false;
    }
  }

  function attachTile({ id, name, stream, isLocal = false }) {
    let tile = document.querySelector(`.video-tile[data-id="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.id = id;
      tile.innerHTML = `<video autoplay playsinline ${isLocal ? 'muted' : ''}></video><div class="video-name"></div>`;
      tile.addEventListener('click', () => promoteStream(stream, name));
      videoGrid?.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    tile.querySelector('.video-name').textContent = name;
  }

  function promoteStream(stream, label) {
    if (!selectedVideo) return;
    selectedVideo.srcObject = stream;
    if (stageEmpty) stageEmpty.style.display = 'none';
    selectedVideo.dataset.label = label || '';
  }

  function renderParticipants() {
    if (!participantsList) return;
    participantsList.innerHTML = '';
    currentState.participants.forEach(p => {
      const row = document.createElement('div');
      row.className = 'participant-item';
      row.innerHTML = `
        <div>
          <strong>${p.display_name}</strong>
          <div class="muted small">${p.full_name}</div>
          <div class="participant-meta">
            ${p.online ? '<span class="badge green">online</span>' : '<span class="badge">offline</span>'}
            ${p.is_eligible ? '<span class="badge">apto</span>' : ''}
            ${p.hand_raised ? '<span class="badge">pediu fala</span>' : ''}
            ${p.mic_blocked ? '<span class="badge red">mic bloqueado</span>' : ''}
            ${p.cam_blocked ? '<span class="badge red">cam bloqueada</span>' : ''}
          </div>
        </div>
        <div class="row gap wrap">
          ${!p.is_admin ? `
          <button class="btn" data-action="toggle_eligible" data-id="${p.id}">Voto</button>
          <button class="btn" data-action="allow_speak" data-id="${p.id}">Liberar</button>
          <button class="btn" data-action="block_mic" data-id="${p.id}">Mic</button>
          <button class="btn" data-action="block_cam" data-id="${p.id}">Cam</button>
          <button class="btn" data-action="spotlight" data-id="${p.id}">Destaque</button>
          <button class="btn danger" data-action="remove" data-id="${p.id}">Remover</button>` : ''}
        </div>`;
      participantsList.appendChild(row);
    });
    participantsList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = () => api(`/admin/api/room/${roomCode}/participant/${btn.dataset.id}`, 'POST', {action: btn.dataset.action});
    });
  }

  function renderVote() {
    const vote = currentState.vote;
    const box = voteBox || document.getElementById('voteStats');
    if (!box) return;
    if (!vote) {
      if (voteBox) box.innerHTML = '';
      else box.textContent = '';
      return;
    }
    const counts = Object.entries(vote.counts || {}).map(([k,v]) => `<div class="badge">${k}: ${v}</div>`).join('');
    const stats = `<div class="row wrap gap"><span class="badge">presentes ${vote.presentes}</span><span class="badge">aptos ${vote.aptos}</span><span class="badge">votaram ${vote.votaram}</span><span class="badge">faltam ${vote.faltam}</span>${counts}</div>`;
    if (role === 'participant' && voteBox) {
      const options = (vote.options || []).map(opt => `<button class="btn btn-primary vote-opt" data-option="${opt}">${opt}</button>`).join('');
      box.innerHTML = `<h3>${vote.title}</h3>${stats}<div class="row wrap gap" style="margin-top:8px">${options}</div><div class="muted small" style="margin-top:8px">${vote.result || ''}</div>`;
      box.querySelectorAll('.vote-opt').forEach(btn => btn.onclick = () => api(`/api/vote/${joinToken}`, 'POST', {option: btn.dataset.option}).then(r => alert(r.message || (r.ok ? 'Voto registrado.' : 'Erro ao votar.'))));
    } else {
      box.innerHTML = `<div>${stats}</div><div class="muted small">${vote.title} · ${vote.result || ''}</div>`;
    }
  }

  function applyState(state) {
    currentState = state;
    renderParticipants();
    renderVote();
  }

  function setupAdminButtons() {
    document.querySelectorAll('[data-bulk]').forEach(btn => btn.onclick = () => api(`/admin/api/room/${roomCode}/bulk`, 'POST', {action: btn.dataset.bulk}));
    document.getElementById('copyInvite')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(document.getElementById('inviteUrl').value);
    });
    document.getElementById('toggleRoom')?.addEventListener('click', async () => {
      const r = await api(`/admin/api/room/${roomCode}/toggle_status`);
      if (r.ok) location.reload();
    });
    document.getElementById('deleteRoom')?.addEventListener('click', async () => {
      if (!confirm('Excluir esta sala?')) return;
      const r = await api(`/admin/api/room/${roomCode}/delete`);
      if (r.ok) location.href = '/admin/dashboard';
    });
    document.getElementById('startVote')?.addEventListener('click', () => {
      const title = document.getElementById('voteTitle').value || 'Votação';
      const options = (document.getElementById('voteOptions').value || 'Sim,Não,Abstenção').split(',').map(x => x.trim()).filter(Boolean);
      const rule = document.getElementById('voteRule').value;
      const secret = document.getElementById('voteSecret').checked;
      api(`/admin/api/room/${roomCode}/vote`, 'POST', {title, options, rule, secret});
    });
    document.getElementById('endVote')?.addEventListener('click', () => api(`/admin/api/room/${roomCode}/vote/end`, 'POST'));
  }

  function setupParticipantButtons() {
    document.getElementById('raiseHand')?.addEventListener('click', () => socket.emit('raise_hand', {join_token: joinToken}));
    document.getElementById('lowerHand')?.addEventListener('click', () => socket.emit('lower_hand', {join_token: joinToken}));
    document.getElementById('toggleMic')?.addEventListener('click', () => {
      if (!localStream) return;
      micEnabled = !micEnabled;
      localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
      document.getElementById('toggleMic').classList.toggle('off', !micEnabled);
    });
    document.getElementById('toggleCam')?.addEventListener('click', () => {
      if (!localStream) return;
      camEnabled = !camEnabled;
      localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
      document.getElementById('toggleCam').classList.toggle('off', !camEnabled);
    });
    document.getElementById('toggleFullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
  }

  function createPeer(targetId, polite=false) {
    const pc = new RTCPeerConnection({ iceServers: [{urls: 'stun:stun.l.google.com:19302'}] });
    peers[targetId] = pc;
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    pc.onicecandidate = ev => {
      if (ev.candidate) socket.emit('signal', {join_token: joinToken, target_id: targetId, type: 'ice', candidate: ev.candidate});
    };
    pc.ontrack = ev => {
      const stream = ev.streams[0];
      remoteStreams[targetId] = stream;
      const p = currentState.participants.find(x => x.id === targetId);
      attachTile({id: targetId, name: p ? p.display_name : `Participante ${targetId}`, stream});
      const selected = currentState.room?.selected_id || currentState.room?.speaker_id;
      if ((selected && Number(selected) === Number(targetId)) || !selectedVideo.srcObject) promoteStream(stream, p ? p.display_name : 'Participante');
    };
    pc.onconnectionstatechange = () => {
      if (['failed','closed','disconnected'].includes(pc.connectionState)) {
        delete peers[targetId];
      }
    };
    return pc;
  }

  async function callPeer(targetId) {
    const pc = createPeer(targetId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', {join_token: joinToken, target_id: targetId, type: 'offer', description: pc.localDescription});
  }

  async function handleSignal(data) {
    const fromId = Number(data.from_id);
    let pc = peers[fromId] || createPeer(fromId, true);
    if (data.type === 'offer') {
      await pc.setRemoteDescription(data.description);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', {join_token: joinToken, target_id: fromId, type: 'answer', description: pc.localDescription});
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.description);
    } else if (data.type === 'ice' && data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn(e); }
    }
  }

  function setupAudioLevel(stream) {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a,b)=>a+b,0) / data.length;
        socket.emit('speaker_update', {join_token: joinToken, speaking: avg > 14 && micEnabled});
      }, 900);
    } catch (e) { console.warn('audio meter off', e); }
  }

  socket.on('connect', async () => {
    await startMedia();
    socket.emit('join_room', {join_token: joinToken});
  });

  socket.on('joined_ok', data => { if (data.participant_id) myId = Number(data.participant_id); });
  socket.on('room_state', state => {
    const previousIds = new Set((currentState.participants || []).filter(p => p.online).map(p => p.id));
    applyState(state);
    (state.participants || []).filter(p => p.online && p.id !== myId).forEach(p => {
      if (!peers[p.id] && !previousIds.has(p.id)) callPeer(p.id);
    });
    const selected = state.room?.selected_id || state.room?.speaker_id;
    if (selected && remoteStreams[selected]) {
      const p = state.participants.find(x => x.id === selected);
      promoteStream(remoteStreams[selected], p ? p.display_name : 'Participante');
    }
  });
  socket.on('signal', handleSignal);
  socket.on('removed', payload => { alert(payload.reason || 'Removido da sala.'); location.href = '/'; });
  socket.on('speaker_changed', payload => {
    const sid = Number(payload.speaker_id || 0);
    document.querySelectorAll('.video-tile').forEach(el => el.classList.toggle('active', Number(el.dataset.id) === sid));
    if (sid && remoteStreams[sid]) {
      const p = currentState.participants.find(x => x.id === sid);
      promoteStream(remoteStreams[sid], p ? p.display_name : 'Participante');
    }
  });

  if (role === 'admin') setupAdminButtons(); else setupParticipantButtons();
  applyState(currentState);
})();
