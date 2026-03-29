
(() => {
  const root = document.querySelector('[data-join-token]');
  if (!root) return;

  const role = root.dataset.role;
  const joinToken = root.dataset.joinToken;
  const roomCode = root.dataset.roomCode;
  let myParticipantId = Number(root.dataset.participantId || 0);

  const socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 1000
  });

  const peers = {};
  const remoteStreams = {};
  let localStream = null;
  let screenStream = null;
  let currentState = window.__INITIAL_STATE__ || { room: {}, participants: [] };
  let micEnabled = true;
  let camEnabled = true;
  let isSharingScreen = false;

  const selectedVideo = document.getElementById('selectedVideo');
  const stageEmpty = document.getElementById('stageEmpty');
  const videoGrid = document.getElementById('videoGrid');
  const participantsList = document.getElementById('participantsList');
  const voteBox = document.getElementById('voteBox');
  const roomMeta = document.getElementById('roomMeta');

  function showMessage(msg) {
    if (stageEmpty) {
      stageEmpty.textContent = msg;
      stageEmpty.style.display = '';
    }
  }

  async function api(url, method = 'POST', body = null) {
    const res = await fetch(url, {
      method,
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : null
    });
    const data = await res.json().catch(() => ({ok:false, message:'Erro inesperado'}));
    if (!data.ok && data.message) alert(data.message);
    return data;
  }

  function findParticipant(id) {
    return (currentState.participants || []).find(p => Number(p.id) === Number(id));
  }

  function currentSelectedId() {
    const room = currentState.room || {};
    return Number(room.screen_share_id || room.selected_id || room.speaker_id || 0);
  }

  function attachTile({ id, name, stream, isLocal = false }) {
    if (!videoGrid) return;
    let tile = videoGrid.querySelector(`.video-tile[data-id="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.id = id;
      tile.innerHTML = `<video autoplay playsinline></video><div class="video-name"></div>`;
      tile.addEventListener('click', () => promoteStream(stream, name, isLocal));
      videoGrid.appendChild(tile);
    }
    const video = tile.querySelector('video');
    video.srcObject = stream;
    video.muted = isLocal;
    video.playsInline = true;
    video.autoplay = true;
    tile.querySelector('.video-name').textContent = name;
  }

  function removeTile(id) {
    const tile = videoGrid?.querySelector(`.video-tile[data-id="${id}"]`);
    if (tile) tile.remove();
    delete remoteStreams[id];
    if (peers[id]) {
      try { peers[id].close(); } catch (e) {}
      delete peers[id];
    }
  }

  function promoteStream(stream, label, isLocal = false) {
    if (!selectedVideo || !stream) return;
    selectedVideo.srcObject = stream;
    selectedVideo.muted = !!isLocal;
    selectedVideo.dataset.label = label || '';
    if (stageEmpty) stageEmpty.style.display = 'none';
  }

  function updateStageSelection() {
    const selected = currentSelectedId();
    document.querySelectorAll('.video-tile').forEach(el => {
      const id = Number(el.dataset.id);
      el.classList.toggle('selected', selected && id === selected);
      const p = findParticipant(id);
      el.classList.toggle('active', p?.speaking || false);
    });

    if (selected) {
      if (Number(selected) === Number(myParticipantId) && localStream) {
        promoteStream(localStream, 'Você', true);
        return;
      }
      if (remoteStreams[selected]) {
        const p = findParticipant(selected);
        promoteStream(remoteStreams[selected], p ? p.display_name : 'Participante');
        return;
      }
    }

    if (!selectedVideo?.srcObject && localStream) promoteStream(localStream, 'Você', true);
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
            ${p.speaking ? '<span class="badge green">falando</span>' : ''}
          </div>
        </div>
        <div class="row gap wrap">
          ${!p.is_admin ? `
          <button class="btn" data-action="toggle_eligible" data-id="${p.id}">${p.is_eligible ? 'Tirar voto' : 'Apto voto'}</button>
          <button class="btn" data-action="allow_speak" data-id="${p.id}">Liberar</button>
          <button class="btn" data-action="block_mic" data-id="${p.id}">${p.mic_blocked ? 'Liberar mic' : 'Bloq mic'}</button>
          <button class="btn" data-action="block_cam" data-id="${p.id}">${p.cam_blocked ? 'Liberar cam' : 'Bloq cam'}</button>
          <button class="btn" data-action="spotlight" data-id="${p.id}">Destaque</button>
          <button class="btn danger" data-action="remove" data-id="${p.id}">Remover</button>` : ''}
        </div>`;
      participantsList.appendChild(row);
    });
    participantsList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = async () => {
        const res = await api(`/admin/api/room/${roomCode}/participant/${btn.dataset.id}`, 'POST', {action: btn.dataset.action});
        if (res.ok && btn.dataset.action === 'remove') {
          removeTile(btn.dataset.id);
        }
      };
    });
  }

  function renderVote() {
    const vote = currentState.vote;
    const adminBox = document.getElementById('voteStats');
    if (!vote) {
      if (voteBox) voteBox.innerHTML = '';
      if (adminBox) adminBox.innerHTML = '';
      return;
    }

    const counts = Object.entries(vote.counts || {})
      .map(([k, v]) => `<span class="badge">${k}: ${v}</span>`).join('');
    const statusHtml = `
      <div class="row wrap gap">
        <span class="badge">presentes ${vote.presentes}</span>
        <span class="badge">aptos ${vote.aptos}</span>
        <span class="badge">votaram ${vote.votaram}</span>
        <span class="badge">faltam ${vote.faltam}</span>
        ${counts}
      </div>
      <div class="muted small" style="margin-top:8px">${vote.title} · ${vote.result || ''}</div>
    `;

    if (adminBox) adminBox.innerHTML = statusHtml;

    if (voteBox) {
      const options = (vote.options || []).map(opt =>
        `<button class="btn btn-primary vote-opt" data-option="${opt}">${opt}</button>`
      ).join('');
      voteBox.innerHTML = `
        <h3 style="margin:0 0 8px">${vote.title}</h3>
        ${statusHtml}
        <div class="row wrap gap" style="margin-top:10px">${options}</div>
      `;
      voteBox.querySelectorAll('.vote-opt').forEach(btn => {
        btn.onclick = async () => {
          const res = await api(`/api/vote/${joinToken}`, 'POST', { option: btn.dataset.option });
          if (res.ok) alert('Voto registrado.');
        };
      });
    }
  }

  function applyState(state) {
    currentState = state || currentState;
    if (roomMeta) roomMeta.textContent = `${currentState.room.code} · ${currentState.room.status}`;
    renderParticipants();
    renderVote();
    updateStageSelection();

    if (currentState.room?.status === 'ended' && role === 'participant') {
      alert('A reunião foi encerrada.');
      location.href = '/';
    }

    const onlineIds = new Set((currentState.participants || []).filter(p => p.online).map(p => Number(p.id)));
    Object.keys(remoteStreams).forEach(id => {
      if (!onlineIds.has(Number(id))) removeTile(Number(id));
    });
  }

  function setupAudioLevel(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.frequencyBinCount);
      setInterval(() => {
        if (!localStream) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        socket.emit('speaker_update', { join_token: joinToken, speaking: avg > 18 && micEnabled });
      }, 800);
    } catch (e) {
      console.warn('audio meter off', e);
    }
  }

  async function startMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      attachTile({ id: myParticipantId || -1, name: role === 'admin' ? 'Administrador' : 'Você', stream: localStream, isLocal: true });
      if (!currentSelectedId()) promoteStream(localStream, role === 'admin' ? 'Administrador' : 'Você', true);
      setupAudioLevel(localStream);
      return true;
    } catch (e) {
      console.error(e);
      showMessage('Permita câmera e microfone para entrar.');
      return false;
    }
  }

  function createPeer(targetId) {
    if (peers[targetId]) return peers[targetId];
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    peers[targetId] = pc;

    const sourceStream = screenStream || localStream;
    if (sourceStream) {
      sourceStream.getTracks().forEach(track => pc.addTrack(track, sourceStream));
    }

    pc.onicecandidate = ev => {
      if (ev.candidate) {
        socket.emit('signal', {
          join_token: joinToken,
          target_id: targetId,
          type: 'ice',
          candidate: ev.candidate
        });
      }
    };

    pc.ontrack = ev => {
      const stream = ev.streams[0];
      remoteStreams[targetId] = stream;
      const p = findParticipant(targetId);
      attachTile({ id: targetId, name: p ? p.display_name : `Participante ${targetId}`, stream });
      if (!selectedVideo?.srcObject || currentSelectedId() === Number(targetId)) {
        promoteStream(stream, p ? p.display_name : 'Participante', false);
      }
      updateStageSelection();
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        removeTile(targetId);
      }
    };

    return pc;
  }

  async function callPeer(targetId) {
    try {
      const pc = createPeer(targetId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', {
        join_token: joinToken,
        target_id: targetId,
        type: 'offer',
        description: pc.localDescription
      });
    } catch (e) {
      console.error('callPeer', e);
    }
  }

  async function handleSignal(data) {
    try {
      const fromId = Number(data.from_id);
      const pc = peers[fromId] || createPeer(fromId);
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', {
          join_token: joinToken,
          target_id: fromId,
          type: 'answer',
          description: pc.localDescription
        });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.description));
      } else if (data.type === 'ice' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (e) {
      console.error('handleSignal', e);
    }
  }

  async function replaceTracksForAllPeers(stream) {
    Object.values(peers).forEach(pc => {
      const senders = pc.getSenders();
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
      if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
    });
  }

  async function startScreenShare() {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      isSharingScreen = true;
      attachTile({ id: myParticipantId, name: 'Sua tela', stream: screenStream, isLocal: true });
      promoteStream(screenStream, 'Sua tela', true);
      await replaceTracksForAllPeers(screenStream);
      socket.emit('screen_share', { join_token: joinToken, active: true });
      const track = screenStream.getVideoTracks()[0];
      if (track) track.onended = stopScreenShare;
    } catch (e) {
      console.error(e);
    }
  }

  async function stopScreenShare() {
    if (!isSharingScreen) return;
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    isSharingScreen = false;
    if (localStream) {
      await replaceTracksForAllPeers(localStream);
      attachTile({ id: myParticipantId, name: role === 'admin' ? 'Administrador' : 'Você', stream: localStream, isLocal: true });
      promoteStream(localStream, role === 'admin' ? 'Administrador' : 'Você', true);
    }
    socket.emit('screen_share', { join_token: joinToken, active: false });
  }

  function setupAdminButtons() {
    document.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.onclick = async () => { await api(`/admin/api/room/${roomCode}/bulk`, 'POST', { action: btn.dataset.bulk }); };
    });

    document.getElementById('copyInvite')?.addEventListener('click', async () => {
      const input = document.getElementById('inviteUrl');
      if (input?.value) await navigator.clipboard.writeText(input.value);
    });

    document.getElementById('copyCamera')?.addEventListener('click', async () => {
      const input = document.getElementById('cameraUrl');
      if (input?.value) await navigator.clipboard.writeText(input.value);
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

    document.getElementById('startVote')?.addEventListener('click', async () => {
      const title = document.getElementById('voteTitle')?.value || '';
      const options = (document.getElementById('voteOptions')?.value || 'Sim,Não,Abstenção')
        .split(',').map(x => x.trim()).filter(Boolean);
      const rule = document.getElementById('voteRule')?.value || 'simple_majority';
      const secret = document.getElementById('voteSecret')?.checked || false;
      const res = await api(`/admin/api/room/${roomCode}/vote`, 'POST', { title, options, rule, secret });
      if (res.ok) alert('Votação aberta.');
    });

    document.getElementById('endVote')?.addEventListener('click', async () => {
      const res = await api(`/admin/api/room/${roomCode}/vote/end`, 'POST');
      if (res.ok) alert('Votação encerrada.');
    });

    document.getElementById('toggleMic')?.addEventListener('click', () => toggleMic());
    document.getElementById('toggleCam')?.addEventListener('click', () => toggleCam());
    document.getElementById('shareScreen')?.addEventListener('click', async () => {
      if (isSharingScreen) await stopScreenShare();
      else await startScreenShare();
      document.getElementById('shareScreen').classList.toggle('off', isSharingScreen);
    });
  }

  function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    document.getElementById('toggleMic')?.classList.toggle('off', !micEnabled);
  }

  function toggleCam() {
    if (!localStream) return;
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    document.getElementById('toggleCam')?.classList.toggle('off', !camEnabled);
  }

  function setupParticipantButtons() {
    document.getElementById('raiseHand')?.addEventListener('click', () => socket.emit('raise_hand', { join_token: joinToken }));
    document.getElementById('lowerHand')?.addEventListener('click', () => socket.emit('lower_hand', { join_token: joinToken }));
    document.getElementById('toggleMic')?.addEventListener('click', () => toggleMic());
    document.getElementById('toggleCam')?.addEventListener('click', () => toggleCam());
    document.getElementById('toggleFullscreen')?.addEventListener('click', () => {
      const target = document.documentElement;
      if (!document.fullscreenElement) target.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
    document.getElementById('shareScreen')?.addEventListener('click', async () => {
      if (isSharingScreen) await stopScreenShare();
      else await startScreenShare();
      document.getElementById('shareScreen').classList.toggle('off', isSharingScreen);
    });
  }

  socket.on('connect', async () => {
    await startMedia();
    socket.emit('join_room', { join_token: joinToken });
  });

  socket.on('joined_ok', data => {
    if (data?.participant_id) {
      myParticipantId = Number(data.participant_id);
      if (localStream) attachTile({ id: myParticipantId, name: role === 'admin' ? 'Administrador' : 'Você', stream: localStream, isLocal: true });
    }
  });

  socket.on('room_state', state => {
    const oldOnlineIds = new Set((currentState.participants || []).filter(p => p.online).map(p => Number(p.id)));
    applyState(state);

    (state.participants || []).filter(p => p.online && Number(p.id) !== Number(myParticipantId)).forEach(p => {
      if (!peers[p.id] || !oldOnlineIds.has(Number(p.id))) callPeer(Number(p.id));
    });
  });

  socket.on('signal', handleSignal);

  socket.on('removed', payload => {
    alert(payload?.reason || 'Você foi removido da sala.');
    location.href = '/';
  });

  if (role === 'admin') setupAdminButtons();
  else setupParticipantButtons();

  applyState(currentState);
})();
