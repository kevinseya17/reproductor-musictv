// 0. Verificación y protección contra teléfonos celulares (evita que dañen la reproducción de la TV)
(function enforceDeviceGuard() {
  if (typeof window === 'undefined') return;

  var params = new URLSearchParams(window.location.search);
  if (params.get('force') === '1' || params.get('preview') === '1') return;

  var ua = navigator.userAgent || '';
  var isTV = /SmartTV|Tizen|Web0S|BRAVIA|NetCast|Android TV|GoogleTV|AFT[A-Z]|CrKey|AppleTV|Roku|HbbTV|Xbox|PlayStation/i.test(ua);
  if (isTV) return;

  var isMobileUA = /iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) || 
                   (/Android/i.test(ua) && /Mobile/i.test(ua));
  var isSmall = (window.innerWidth < 800 || screen.width < 800) && (window.innerHeight > window.innerWidth || screen.height > window.width);
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  if (window.__IS_MOBILE_BLOCKED__ || isMobileUA || (isSmall && isTouch)) {
    console.warn('[TV Player] Acceso bloqueado en teléfono móvil para proteger la pantalla.');
    window.onYouTubeIframeAPIReady = function() {};
    throw new Error('[TV Player] Bloqueado en teléfono celular para evitar interrupciones en la pantalla del bar.');
  }
})();

const socket = io();

let ytPlayer = null;
let currentVideoId = null;
let isPlayerReady = false;
let pendingVideoId = null;

// Configuración y estado de reproducción / DJ
let currentSettings = {
  fadeTransitionEnabled: true,
  maxSongDuration: 0, // 0 = canción completa por defecto (sin cortes)
  dynamicDurationOnQueue: false
};
let currentQueue = [];
let currentlyPlayingSong = null;
let masterVolume = 100;
let isFading = false;
let activeFadeInterval = null;
let progressMonitorInterval = null;
let hasReportedSongEnded = false;
let isFadingInNewSong = false;
let savedVolumeBeforeMic = 100;

// Control de anuncios a mitad de canción y mensajes/dedicatorias al inicio y al final
let hasShownMidSongPromo = false;
let hasShownStartDedication = false;
let hasShownEndDedication = false;
let currentTrackInitializedId = null;
let singlePromoSongTimeout = null;
let promoHideTimeout = null;
let promoHideCardTimeout = null;
let dedicationTimer = null;
let dedicationHideTimeout = null;

// ==========================================
// SINTETIZADOR DE EFECTOS DJ (WEB AUDIO API)
// Sin dependencias de archivos externos, latencia cero
// ==========================================
let djAudioCtx = null;
function getDjAudioContext() {
  if (!djAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      djAudioCtx = new AudioCtx();
    }
  }
  if (djAudioCtx && djAudioCtx.state === 'suspended') {
    djAudioCtx.resume();
  }
  return djAudioCtx;
}

// 1. Efecto Vinilo Freno (Vinyl Brake / Scratch Stop)
function playDjVinylBrake() {
  const ctx = getDjAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(320, now);
  osc.frequency.exponentialRampToValueAtTime(30, now + 0.65);
  
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1200, now);
  filter.frequency.exponentialRampToValueAtTime(150, now + 0.65);

  gain.gain.setValueAtTime(0.25, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.7);
}

// 2. Efecto Sweep / Riser Club de DJ
function playDjClubSweep() {
  const ctx = getDjAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const dur = 1.1;

  const bufferSize = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 4.0;
  filter.frequency.setValueAtTime(260, now);
  filter.frequency.exponentialRampToValueAtTime(4800, now + dur * 0.75);
  filter.frequency.exponentialRampToValueAtTime(700, now + dur);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.01, now);
  gain.gain.exponentialRampToValueAtTime(0.35, now + dur * 0.7);
  gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(85, now + dur * 0.7);
  sub.frequency.exponentialRampToValueAtTime(32, now + dur);
  subGain.gain.setValueAtTime(0.35, now + dur * 0.7);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  sub.connect(subGain);
  subGain.connect(ctx.destination);

  noise.start(now);
  noise.stop(now + dur);
  sub.start(now + dur * 0.7);
  sub.stop(now + dur);
}

// 3. Efecto Airhorn Clásico de DJ (Hype Drop)
function playDjAirhorn() {
  const ctx = getDjAudioContext();
  if (!ctx) return;
  const bursts = [
    { start: 0.0, dur: 0.14 },
    { start: 0.18, dur: 0.14 },
    { start: 0.36, dur: 0.42 }
  ];
  const freqs = [466.16, 622.25, 932.33];

  bursts.forEach(burst => {
    const startTime = ctx.currentTime + burst.start;
    freqs.forEach(freq => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.linearRampToValueAtTime(freq * 1.02, startTime + burst.dur * 0.5);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.95, startTime + burst.dur);

      gain.gain.setValueAtTime(0.12, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + burst.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + burst.dur);
    });
  });
}

function showDjFxFlash(text, icon = '🎛️') {
  const notice = document.getElementById('djFxNotice');
  const noticeText = document.getElementById('djFxNoticeText');
  const noticeIcon = document.getElementById('djFxNoticeIcon');
  if (!notice) return;

  if (noticeText) noticeText.textContent = text;
  if (noticeIcon) noticeIcon.textContent = icon;

  notice.classList.remove('hidden');
  setTimeout(() => {
    notice.classList.remove('opacity-0', 'scale-95');
    notice.classList.add('opacity-100', 'scale-100');
  }, 30);

  clearTimeout(window._djNoticeTimer);
  window._djNoticeTimer = setTimeout(() => {
    notice.classList.remove('opacity-100', 'scale-100');
    notice.classList.add('opacity-0', 'scale-95');
    setTimeout(() => notice.classList.add('hidden'), 350);
  }, 2500);
}

// 1. YouTube IFrame API Callback global
window.onYouTubeIframeAPIReady = function() {
  ytPlayer = new YT.Player('ytPlayer', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 1,
      controls: 1,
      modestbranding: 1,
      rel: 0,
      fs: 0, // Desactiva el botón nativo de YouTube para evitar que oculte los anuncios
      iv_load_policy: 3
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError
    }
  });
};

function onPlayerReady(event) {
  isPlayerReady = true;
  masterVolume = ytPlayer.getVolume() || 100;
  event.target.playVideo();

  startProgressMonitor();

  if (pendingVideoId) {
    loadAndPlay(pendingVideoId);
    pendingVideoId = null;
  }
}

function onPlayerStateChange(event) {
  const playPauseIcon = document.getElementById('playPauseIcon');

  if (event.data === YT.PlayerState.ENDED) {
    if (!hasReportedSongEnded) {
      hasReportedSongEnded = true;
      console.log('Canción terminada por YouTube, solicitando siguiente...');
      socket.emit('song-ended');
    }
  } else if (event.data === YT.PlayerState.PLAYING) {
    if (playPauseIcon) playPauseIcon.textContent = '⏸️';

    // Si requiere Fade-In suave al iniciar la canción
    if (isFadingInNewSong && currentSettings.fadeTransitionEnabled !== false) {
      isFadingInNewSong = false;
      fadeVolume(0, masterVolume, 1800);
    }

    // Mostrar mensaje/dedicatoria al inicio del tema
    if (currentlyPlayingSong?.requestedBy?.dedication && !hasShownStartDedication) {
      hasShownStartDedication = true;
      showDedicationBanner(16000);
    }
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (playPauseIcon) playPauseIcon.textContent = '▶️';
  }
}

function onPlayerError(event) {
  console.warn('Error en video de YouTube (código ' + event.data + '), saltando al siguiente...');
  setTimeout(() => {
    if (!hasReportedSongEnded) {
      hasReportedSongEnded = true;
      socket.emit('song-ended');
    }
  }, 1500);
}

function loadAndPlay(videoId) {
  if (!videoId) return;
  currentVideoId = videoId;
  hasReportedSongEnded = false;
  isFading = false;
  hasShownMidSongPromo = false;
  hasShownStartDedication = false;
  hasShownEndDedication = false;
  currentTrackInitializedId = videoId;

  // Limpiar anuncios o dedicatorias previos inmediatamente
  if (typeof hidePromoBanner === 'function') hidePromoBanner(true);
  if (typeof hideDedicationBanner === 'function') hideDedicationBanner(true);

  if (activeFadeInterval) {
    clearInterval(activeFadeInterval);
    activeFadeInterval = null;
  }

  // Preparar volumen para inicio suave (Fade In)
  if (currentSettings.fadeTransitionEnabled !== false) {
    isFadingInNewSong = true;
    if (isPlayerReady && ytPlayer && ytPlayer.setVolume) {
      ytPlayer.setVolume(0);
    }
  } else {
    isFadingInNewSong = false;
    if (isPlayerReady && ytPlayer && ytPlayer.setVolume) {
      ytPlayer.setVolume(masterVolume);
    }
  }

  if (isPlayerReady && ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById({
      videoId: videoId,
      suggestedQuality: 'hd1080'
    });
  } else {
    pendingVideoId = videoId;
  }
}

// 2. Controladores de Reproducción
function togglePlayPause() {
  if (!ytPlayer || !isPlayerReady) return;
  const state = ytPlayer.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    ytPlayer.pauseVideo();
  } else {
    ytPlayer.playVideo();
  }
}

async function skipSong() {
  try {
    playDjVinylBrake();
    // Si la transición suave está activa, desvanecer rápido y saltar
    if (currentSettings.fadeTransitionEnabled !== false && ytPlayer && isPlayerReady) {
      fadeVolume(ytPlayer.getVolume(), 0, 700, async () => {
        await fetch('/api/admin/skip', { method: 'POST' });
      });
    } else {
      await fetch('/api/admin/skip', { method: 'POST' });
    }
  } catch (err) {
    console.error('Error saltando canción:', err);
  }
}

function skipCurrentSong() {
  return skipSong();
}

function setVolume(val) {
  masterVolume = val;
  if (ytPlayer && isPlayerReady && !isFading) {
    ytPlayer.setVolume(val);
  }
}

function toggleFullscreen() {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  if (!isFull) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      req.call(el).catch(err => {
        console.warn('Error activando pantalla completa:', err);
        showFullscreenClickPrompt();
      });
    }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) {
      exit.call(document).catch(err => console.warn('Error saliendo de pantalla completa:', err));
    }
  }
}

let fullscreenPromptTimeout = null;

function showFullscreenClickPrompt() {
  let promptEl = document.getElementById('remoteFullscreenPrompt');
  if (!promptEl) {
    promptEl = document.createElement('div');
    promptEl.id = 'remoteFullscreenPrompt';
    promptEl.className = 'fixed top-10 left-1/2 -translate-x-1/2 z-50 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-500 text-black px-8 py-4 rounded-3xl font-black text-base sm:text-xl shadow-[0_0_80px_rgba(245,158,11,0.95)] flex items-center gap-3.5 cursor-pointer animate-bounce border-2 border-white select-none';
    promptEl.innerHTML = `
      <span class="text-3xl">⛶</span>
      <span>Toca la pantalla para activar Pantalla Completa</span>
    `;
    promptEl.onclick = (e) => {
      e.stopPropagation();
      toggleFullscreen();
      promptEl.remove();
    };
    document.body.appendChild(promptEl);
  }

  clearTimeout(fullscreenPromptTimeout);
  fullscreenPromptTimeout = setTimeout(() => {
    if (promptEl && promptEl.parentNode) promptEl.remove();
  }, 12000);

  const oneClickFullscreen = (e) => {
    if (e.target.closest('button, input, select, a')) return;
    toggleFullscreen();
    if (promptEl && promptEl.parentNode) promptEl.remove();
    document.removeEventListener('click', oneClickFullscreen);
  };
  setTimeout(() => {
    document.addEventListener('click', oneClickFullscreen, { once: true });
  }, 100);
}

function handleRemoteFullscreen() {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  if (isFull) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) {
      exit.call(document).catch(err => console.warn('Error saliendo de pantalla completa:', err));
    }
  } else {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      try {
        const promise = req.call(el);
        if (promise && typeof promise.catch === 'function') {
          promise.catch((err) => {
            console.warn('Pantalla completa remota requiere interacción de usuario:', err);
            showFullscreenClickPrompt();
          });
        }
      } catch (err) {
        showFullscreenClickPrompt();
      }
    }
  }
}

// Interceptar cambios de pantalla completa y reportar a la consola de DJ
['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
  document.addEventListener(evt, () => {
    const cur = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    const isFull = !!cur;

    // Notificar al server / admin panel
    if (typeof socket !== 'undefined' && socket.connected) {
      socket.emit('player-fullscreen-status', { isFullscreen: isFull });
    }

    // Si el elemento maximizado es el iframe de YouTube, corregirlo para que sea toda la página web
    if (cur && cur.tagName === 'IFRAME') {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        exit.call(document).then(() => {
          toggleFullscreen();
        }).catch(() => {});
      }
    }
  });
});

// Reportar estado inicial al conectarse el socket
socket.on('connect', () => {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  socket.emit('player-fullscreen-status', { isFullscreen: isFull });
});

// Doble clic en cualquier parte de la pantalla para alternar pantalla completa limpia
document.addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input, select, a')) return;
  toggleFullscreen();
});

// Tecla F para alternar pantalla completa
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      toggleFullscreen();
    }
  }
});

// 3. Monitor de Progreso, Límite de Duración y Fade-Out
function startProgressMonitor() {
  if (progressMonitorInterval) clearInterval(progressMonitorInterval);

  progressMonitorInterval = setInterval(() => {
    if (!ytPlayer || !isPlayerReady) return;
    if (hasReportedSongEnded) return;

    try {
      const state = ytPlayer.getPlayerState();
      if (state !== YT.PlayerState.PLAYING) return;

      const currentTime = ytPlayer.getCurrentTime();
      const duration = ytPlayer.getDuration();
      if (!duration || duration <= 0) return;

      // Emitir telemetría de progreso hacia la consola del DJ (segundo a segundo)
      socket.emit('player-progress', {
        currentTime,
        duration,
        isPlaying: state === YT.PlayerState.PLAYING,
        volume: ytPlayer.getVolume ? ytPlayer.getVolume() : masterVolume
      });

      // Calcular límite de duración configurado
      let targetMaxDuration = duration;
      const configuredMax = currentSettings.maxSongDuration || 0; // 0 = sin límite

      if (configuredMax > 0) {
        if (currentSettings.dynamicDurationOnQueue) {
          // Solo recortar si hay pedidos de clientes en cola o si el tema actual fue pedido por una mesa
          const hasPendingRequests = (currentQueue && currentQueue.length > 0) || (currentlyPlayingSong?.requestedBy?.table);
          if (hasPendingRequests) {
            targetMaxDuration = Math.min(configuredMax, duration);
          }
        } else {
          targetMaxDuration = Math.min(configuredMax, duration);
        }
      }

      const timeLeft = targetMaxDuration - currentTime;
      const midPoint = targetMaxDuration / 2;

      // Sincronización al conectarse o cambiar de tema
      if (currentTrackInitializedId !== currentVideoId) {
        currentTrackInitializedId = currentVideoId;
        if (currentTime > (midPoint + 8)) {
          hasShownMidSongPromo = true;
        }
        if (currentTime > 20) {
          hasShownStartDedication = true;
        }
      }

      // 0. Saludo y Dedicatoria del cliente al inicio de la canción (Visible 16 segundos)
      if (currentlyPlayingSong?.requestedBy?.dedication && !hasShownStartDedication && currentTime <= 18) {
        hasShownStartDedication = true;
        showDedicationBanner(16000);
        console.log(`[TV Player] Saludo/dedicatoria de inicio activada (${Math.round(currentTime)}s)`);
      }

      // 1. Promoción del Bar exactamente a la mitad de la canción (50% de la duración)
      if (!hasShownMidSongPromo && targetMaxDuration > 20) {
        if (currentTime >= midPoint) {
          hasShownMidSongPromo = true;
          showSinglePromo(10000);
          console.log(`[TV Player] Promoción a mitad de canción activada (${Math.round(currentTime)}s de ${Math.round(targetMaxDuration)}s)`);
        }
      }

      // 2. Saludo y Dedicatoria del cliente al final de la canción (Visible 14 segundos)
      if (currentlyPlayingSong?.requestedBy?.dedication && !hasShownEndDedication) {
        if (timeLeft <= 22 && currentTime > (midPoint + 8)) {
          hasShownEndDedication = true;
          showDedicationBanner(14000);
          console.log(`[TV Player] Saludo/dedicatoria de cierre activada (quedan ${Math.round(timeLeft)}s)`);
        }
      }

      // Si quedan 6 segundos o menos para el límite/final y el fundido está activo
      if (currentSettings.fadeTransitionEnabled !== false && timeLeft <= 6 && timeLeft > 0.8) {
        if (!isFading) {
          isFading = true;
          const fadeDuration = Math.max(1200, Math.round(timeLeft * 1000));
          console.log(`Iniciando Fade Out suave de ${Math.round(timeLeft)}s...`);
          fadeVolume(ytPlayer.getVolume(), 0, fadeDuration, () => {
            if (!hasReportedSongEnded) {
              hasReportedSongEnded = true;
              isFading = false;
              console.log('Canción terminada con Fade Out, solicitando siguiente...');
              socket.emit('song-ended');
            }
          });
        }
      } else if (timeLeft <= 0.8 || currentTime >= targetMaxDuration) {
        // Fin de tiempo o fin de video sin fundido
        if (!hasReportedSongEnded) {
          hasReportedSongEnded = true;
          isFading = false;
          console.log('Tiempo límite cumplido, pasando al siguiente tema...');
          socket.emit('song-ended');
        }
      }
    } catch (e) {
      // Chequeos transitorios durante la carga del iframe
    }
  }, 400);
}

// 4. Control Remoto desde la Consola de DJ (Comandos en vivo)
socket.on('player-control', (data) => {
  const { command, value } = data || {};

  // Comando de Pantalla Completa (independiente de si YouTube está listo o reproduciendo)
  if (command === 'fullscreen' || command === 'toggleFullscreen') {
    handleRemoteFullscreen();
    return;
  }

  if (!ytPlayer || !isPlayerReady) return;

  try {
    if (command === 'play') {
      ytPlayer.playVideo();
    } else if (command === 'pause') {
      ytPlayer.pauseVideo();
    } else if (command === 'toggle') {
      const state = ytPlayer.getPlayerState();
      if (state === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
      } else {
        ytPlayer.playVideo();
      }
    } else if (command === 'seek') {
      const seekTime = Math.max(0, Math.min(Number(value) || 0, ytPlayer.getDuration() || 0));
      ytPlayer.seekTo(seekTime, true);
    } else if (command === 'seekRelative') {
      const current = ytPlayer.getCurrentTime() || 0;
      const target = Math.max(0, Math.min(current + (Number(value) || 0), ytPlayer.getDuration() || 0));
      ytPlayer.seekTo(target, true);
    } else if (command === 'skip') {
      skipCurrentSong();
    } else if (command === 'volume') {
      masterVolume = Math.max(0, Math.min(100, parseInt(value, 10)));
      ytPlayer.setVolume(masterVolume);
    }
  } catch (err) {
    console.warn('Error ejecutando player-control:', err);
  }
});

// 5. Escuchar disparos de efectos de DJ desde la consola o transiciones automáticas
socket.on('dj-fx-play', (data) => {
  const type = data?.type || 'sweep';
  const label = data?.bridge?.label || (type === 'airhorn' ? 'Hype Airhorn' : (type === 'vinyl_brake' ? 'Vinyl Brake' : 'Transición DJ'));
  const icon = type === 'airhorn' ? '🎺' : (type === 'vinyl_brake' || type === 'brake' ? '💿' : '🎛️');

  if (type === 'airhorn') {
    playDjAirhorn();
  } else if (type === 'vinyl_brake' || type === 'brake') {
    playDjVinylBrake();
  } else {
    playDjClubSweep();
  }

  showDjFxFlash(label.toUpperCase(), icon);
});

// 4. Fundido de Volumen (Fade Suave)
function fadeVolume(fromVol, targetVol, durationMs = 1500, onComplete = null) {
  if (!ytPlayer || !isPlayerReady) {
    if (onComplete) onComplete();
    return;
  }

  if (activeFadeInterval) {
    clearInterval(activeFadeInterval);
    activeFadeInterval = null;
  }

  const steps = 20;
  const stepTime = Math.max(20, Math.round(durationMs / steps));
  const volStep = (targetVol - fromVol) / steps;
  let currentStep = 0;

  ytPlayer.setVolume(Math.max(0, Math.min(100, Math.round(fromVol))));

  activeFadeInterval = setInterval(() => {
    currentStep++;
    const newVol = Math.round(fromVol + (volStep * currentStep));
    if (ytPlayer && isPlayerReady) {
      ytPlayer.setVolume(Math.max(0, Math.min(100, newVol)));
    }
    if (currentStep >= steps) {
      clearInterval(activeFadeInterval);
      activeFadeInterval = null;
      if (ytPlayer && isPlayerReady) {
        ytPlayer.setVolume(Math.max(0, Math.min(100, targetVol)));
      }
      if (onComplete) onComplete();
    }
  }, stepTime);
}

// 5. Sincronización en tiempo real vía Socket.io
socket.on('state-changed', (data) => {
  if (!data) return;
  const { currentlyPlaying, queue, settings } = data;

  if (settings) {
    currentSettings = { ...currentSettings, ...settings };
    if (settings.barName) {
      document.getElementById('barName').textContent = settings.barName;
    }
    if (settings.promos && Array.isArray(settings.promos)) {
      activePromos = settings.promos;
    }
  }

  currentQueue = queue || [];
  currentlyPlayingSong = currentlyPlaying;

  if (currentlyPlaying) {
    // Si la canción cambió, cargar el nuevo video
    if (currentlyPlaying.videoId && currentlyPlaying.videoId !== currentVideoId) {
      loadAndPlay(currentlyPlaying.videoId);
    }

    document.getElementById('currentTitle').textContent = currentlyPlaying.title || 'Música';
    document.getElementById('currentArtist').textContent = currentlyPlaying.artist || '';
    document.getElementById('currentThumb').src = currentlyPlaying.thumbnail || '';

    const genreEl = document.getElementById('currentGenre');
    genreEl.textContent = currentlyPlaying.genre || 'Música';
    genreEl.className = `genre-badge genre-${currentlyPlaying.genre || 'Crossover'}`;

    const reqBadge = document.getElementById('requestedByBadge');
    if (currentlyPlaying.requestedBy && currentlyPlaying.requestedBy.table) {
      reqBadge.textContent = `🎉 Pedida por Mesa ${currentlyPlaying.requestedBy.table}`;
      reqBadge.className = 'bg-amber-500 text-black font-extrabold text-xs px-3 py-1 rounded-full animate-pulse';
    } else {
      reqBadge.textContent = `✨ Lista Base del Bar`;
      reqBadge.className = 'bg-white/10 text-gray-300 font-medium text-xs px-3 py-1 rounded-full';
    }

    // Indicador DJ de Vibra & BPM
    const vibeBadge = document.getElementById('currentVibeBadge');
    const vibeText = document.getElementById('currentVibeText');
    if (vibeBadge && vibeText) {
      if (currentlyPlaying.vibe || currentlyPlaying.bpm) {
        const bpmText = currentlyPlaying.bpm ? ` (${currentlyPlaying.bpm} BPM)` : '';
        vibeText.textContent = `${currentlyPlaying.vibe || 'Modo Fiesta'}${bpmText}`;
        vibeBadge.classList.remove('hidden');
        vibeBadge.classList.add('inline-flex');
      } else {
        vibeBadge.classList.add('hidden');
        vibeBadge.classList.remove('inline-flex');
      }
    }

    // Saludo / Dedicatoria especial en TV al inicio del tema (Visible 16 segundos)
    if (currentlyPlaying.requestedBy && currentlyPlaying.requestedBy.dedication) {
      if (!hasShownStartDedication) {
        hasShownStartDedication = true;
        setTimeout(() => {
          showDedicationBanner(16000);
        }, 150);
      }
    } else {
      hideDedicationBanner(true);
    }

    // Mostrar información de canción durante 10 segundos y luego ocultar suavemente para dejar el video 100% limpio
    showSongOverlay(10000);
  }

  // Siguiente canción
  if (queue && queue.length > 0) {
    const next = queue[0];
    document.getElementById('nextTitle').textContent = next.title;
    document.getElementById('nextGenre').textContent = `[${next.genre || 'Música'}] - ${next.requestedBy?.table ? 'Mesa ' + next.requestedBy.table : 'Bar'}`;
  } else {
    document.getElementById('nextTitle').textContent = 'Continuará con la lista base';
    document.getElementById('nextGenre').textContent = 'DJ Inteligente';
  }
});

// Auto-ocultamiento de todos los elementos visuales a los 10 segundos para dejar el video 100% limpio
let overlayHideTimeout = null;

function showSongOverlay(durationMs = 10000) {
  // Mostrar todos los elementos del HUD
  document.body.classList.remove('tv-idle');
  const footer = document.getElementById('songInfoFooter');
  if (footer) {
    footer.classList.remove('opacity-0', 'translate-y-8', 'pointer-events-none');
    footer.classList.add('opacity-100', 'translate-y-0');
  }

  clearTimeout(overlayHideTimeout);
  if (durationMs > 0) {
    overlayHideTimeout = setTimeout(() => {
      // Ocultar todos los elementos informativos (header, logo, QR, footer, controles)
      document.body.classList.add('tv-idle');
      if (footer) {
        footer.classList.remove('opacity-100', 'translate-y-0');
        footer.classList.add('opacity-0', 'translate-y-8', 'pointer-events-none');
      }
    }, durationMs);
  }
}

// Despertar overlay al mover el mouse o tocar la pantalla (y auto-ocultar a los 6 segundos)
document.addEventListener('mousemove', () => showSongOverlay(6000));
document.addEventListener('touchstart', () => showSongOverlay(6000));
document.addEventListener('click', () => showSongOverlay(6000));

// Promociones en Gran Formato para TV
let activePromos = [
  '🍻 ¡Pregunta por nuestras promociones de bebidas en la barra!',
  '🍔 Prueba nuestras deliciosas picadas y platos especiales de la casa',
  '🥃 Pide tu botella favorita para compartir con tu parche'
];
let currentPromoIdx = 0;

function getPromoIcon(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('cerveza') || lower.includes('pola')) return '🍻';
  if (lower.includes('comida') || lower.includes('alita') || lower.includes('picada') || lower.includes('hamburguesa')) return '🍔';
  if (lower.includes('botella') || lower.includes('whisky') || lower.includes('guaro') || lower.includes('ron') || lower.includes('tequila')) return '🥃';
  if (lower.includes('cumple') || lower.includes('fiesta')) return '🎉';
  return '🔥';
}

/**
 * Muestra exactamente un solo anuncio/promoción por canción
 * Se activa a la mitad exacta de la duración de la canción (50%).
 */
function scheduleSinglePromoForCurrentSong() {
  hasShownMidSongPromo = false;
  hidePromoBanner(true);
}

function hidePromoBanner(immediate = false) {
  clearTimeout(singlePromoSongTimeout);
  clearTimeout(promoHideTimeout);
  clearTimeout(promoHideCardTimeout);
  const promoCard = document.getElementById('promoBroadcastCard');
  if (promoCard) {
    promoCard.classList.remove('opacity-100', 'translate-y-0');
    promoCard.classList.add('opacity-0', 'translate-y-8');
    if (immediate) {
      promoCard.classList.add('hidden');
    } else {
      promoHideCardTimeout = setTimeout(() => promoCard.classList.add('hidden'), 500);
    }
  }
}

function showSinglePromo(durationMs = 10000) {
  if (!activePromos || activePromos.length === 0) return;
  const promoCard = document.getElementById('promoBroadcastCard');
  const promoTextEl = document.getElementById('promoLargeText');
  const promoIconEl = document.getElementById('promoIcon');
  if (!promoCard || !promoTextEl) return;

  // Cancelar cualquier timeout previo
  clearTimeout(promoHideTimeout);
  clearTimeout(promoHideCardTimeout);

  // Ocultar dedicatoria si estuviese activa de inmediato
  hideDedicationBanner(true);

  const promoMsg = activePromos[currentPromoIdx];
  currentPromoIdx = (currentPromoIdx + 1) % activePromos.length;

  promoTextEl.textContent = promoMsg;
  if (promoIconEl) promoIconEl.textContent = getPromoIcon(promoMsg);

  promoCard.classList.remove('hidden');
  setTimeout(() => {
    promoCard.classList.remove('opacity-0', 'translate-y-8');
    promoCard.classList.add('opacity-100', 'translate-y-0');
  }, 50);

  promoHideTimeout = setTimeout(() => {
    hidePromoBanner(false);
  }, durationMs);
}

/**
 * Muestra el mensaje o dedicatoria del cliente en gran formato en TV.
 * Se muestra al inicio del tema (16 segundos) y vuelve a mostrarse al final de la canción (14 segundos).
 */
function showDedicationBanner(durationMs = 16000) {
  clearTimeout(dedicationTimer);
  clearTimeout(dedicationHideTimeout);

  const dedBanner = document.getElementById('dedicationBanner');
  const dedText = document.getElementById('dedicationText');
  const dedFromText = document.getElementById('dedicationFromText');
  if (!dedBanner || !dedText || !dedFromText) return;

  const req = currentlyPlayingSong?.requestedBy;
  if (!req || !req.dedication || !req.dedication.trim()) {
    dedBanner.classList.add('hidden');
    return;
  }

  // Ocultar promo de inmediato si estuviese activa
  hidePromoBanner(true);

  const fromName = req.name ? req.name : (req.table ? `Mesa ${req.table}` : 'Cliente');
  dedFromText.textContent = `MENSAJE ESPECIAL DE ${fromName.toUpperCase()}`;
  dedText.textContent = `"${req.dedication.trim()}"`;

  dedBanner.classList.remove('hidden');
  setTimeout(() => {
    dedBanner.classList.remove('opacity-0', 'translate-y-6');
    dedBanner.classList.add('opacity-100', 'translate-y-0');
  }, 50);

  dedicationTimer = setTimeout(() => {
    hideDedicationBanner(false);
  }, durationMs);
}

function hideDedicationBanner(immediate = false) {
  clearTimeout(dedicationTimer);
  clearTimeout(dedicationHideTimeout);
  const dedBanner = document.getElementById('dedicationBanner');
  if (dedBanner) {
    dedBanner.classList.remove('opacity-100', 'translate-y-0');
    dedBanner.classList.add('opacity-0', 'translate-y-6');
    if (immediate) {
      dedBanner.classList.add('hidden');
    } else {
      dedicationHideTimeout = setTimeout(() => dedBanner.classList.add('hidden'), 500);
    }
  }
}

// Modo Micrófono / Anuncio con Fade Suave de Volumen
socket.on('mic-mode', ({ active }) => {
  const indicator = document.getElementById('micModeIndicator');
  if (!ytPlayer || !isPlayerReady) return;

  if (active) {
    if (indicator) indicator.classList.remove('hidden');
    savedVolumeBeforeMic = ytPlayer.getVolume() || masterVolume || 100;
    fadeVolume(savedVolumeBeforeMic, 15, 1200);
  } else {
    if (indicator) indicator.classList.add('hidden');
    fadeVolume(ytPlayer.getVolume(), savedVolumeBeforeMic, 1200);
  }
});

// Alerta animada en pantalla cuando entra una petición
socket.on('new-request-alert', (data) => {
  const notif = document.getElementById('newRequestNotification');
  const text = document.getElementById('newRequestText');

  if (notif && text && data.song) {
    const tableStr = data.song.requestedBy?.table ? `Mesa ${data.song.requestedBy.table}` : 'un cliente';
    const dedicationStr = data.song.requestedBy?.dedication ? ` — "${data.song.requestedBy.dedication}"` : '';
    text.textContent = `¡Nuevo pedido de ${tableStr}: "${data.song.title}"${dedicationStr}!`;
    notif.classList.remove('hidden');

    setTimeout(() => {
      notif.classList.add('hidden');
    }, 6000);
  }
});

// Cargar QR para la esquina de la pantalla
async function loadScreenQR() {
  try {
    const res = await fetch('/api/qrs');
    const data = await res.json();
    if (data.qrs && data.qrs.length > 0) {
      // Usar QR general o el de la mesa 1
      document.getElementById('screenQr').src = data.qrs[0].qrDataUrl;
    }
  } catch (err) {
    console.warn('No se pudo cargar QR en pantalla:', err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadScreenQR();
});
