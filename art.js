document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('page-content');
  if (!container) return;

  const slug = new URLSearchParams(window.location.search).get('post');

  let posts;
  try {
    const res = await fetch('./assets/art-posts/index.json');
    posts = await res.json();
  } catch (err) {
    container.textContent = 'Unable to load art posts.';
    return;
  }

  if (slug) {
    const post = posts.find((p) => p.slug === slug);
    if (!post) {
      container.textContent = 'Post not found.';
      return;
    }
    await renderPost(container, post);
  } else {
    renderPostList(container, posts);
  }
});

const TYPE_ICONS = {
  music: { src: './assets/img/sound-icon.webp', alt: 'Music post' },
  visual: { src: './assets/img/visual-icon.webp', alt: 'Visual art post' },
};

function renderPostList(container, posts) {
  if (!posts.length) {
    const empty = document.createElement('p');
    empty.className = 'art-empty';
    empty.textContent = 'No pieces posted yet. Check back soon.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'art-list';

  posts
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .forEach((post) => {
      const item = document.createElement('li');
      item.className = 'art-list-item';

      const link = document.createElement('a');
      link.href = `./art.html?post=${encodeURIComponent(post.slug)}`;
      link.className = 'art-list-title';

      const icon = TYPE_ICONS[post.type];
      if (icon) {
        const iconImg = document.createElement('img');
        iconImg.className = 'art-list-icon';
        iconImg.src = icon.src;
        iconImg.alt = icon.alt;
        link.appendChild(iconImg);
      }

      const titleSpan = document.createElement('span');
      titleSpan.textContent = post.title;
      link.appendChild(titleSpan);

      item.appendChild(link);

      if (post.date) {
        const time = document.createElement('time');
        time.className = 'art-post-date';
        time.dateTime = post.date;
        time.textContent = post.date;
        item.appendChild(time);
      }

      if (post.preview) {
        const preview = document.createElement('p');
        preview.className = 'art-list-preview';
        preview.textContent = post.preview;
        item.appendChild(preview);
      }

      list.appendChild(item);
    });

  container.appendChild(list);
}

function renderPost(container, post) {
  const detail = post;

  const article = document.createElement('article');
  article.className = 'art-post art-post-full';

  const back = document.createElement('a');
  back.href = './art.html';
  back.className = 'art-back-link';
  back.textContent = '\u2190 Back to all pieces';
  article.appendChild(back);

  const heading = document.createElement('h1');
  heading.className = 'art-post-title';
  heading.textContent = detail.title;
  article.appendChild(heading);

  if (detail.date) {
    const time = document.createElement('time');
    time.className = 'art-post-date';
    time.dateTime = detail.date;
    time.textContent = detail.date;
    article.appendChild(time);
  }

  if (detail.summary) {
    const summary = document.createElement('div');
    summary.className = 'art-post-summary';
    summary.innerHTML = renderMarkdown(detail.summary);
    article.appendChild(summary);
  }

  if (detail.type === 'music') {
    buildMusicPlayer(article, detail);
  } else if (detail.type === 'visual') {
    buildImageCarousel(article, detail);
  }

  container.appendChild(article);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderMarkdown(markdown) {
  const converter = new Markdown.Converter();
  return converter.makeHtml(markdown);
}

function buildMusicPlayer(article, detail) {
  const tracks = detail.tracks || [];
  if (!tracks.length) return;

  let trackIndex = 0;

  const layout = document.createElement('div');
  layout.className = 'art-player-layout';

  const player = document.createElement('div');
  player.className = 'art-player';

  const trackTitle = document.createElement('div');
  trackTitle.className = 'art-player-track-title';
  player.appendChild(trackTitle);

  const controls = document.createElement('div');
  controls.className = 'art-player-controls';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'art-player-btn art-player-prev';
  prevBtn.setAttribute('aria-label', 'Previous track');
  prevBtn.textContent = '\u23EE';

  const playPauseBtn = document.createElement('button');
  playPauseBtn.type = 'button';
  playPauseBtn.className = 'art-player-btn art-player-playpause';
  playPauseBtn.setAttribute('aria-label', 'Play');
  playPauseBtn.textContent = '\u25B6';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'art-player-btn art-player-next';
  nextBtn.setAttribute('aria-label', 'Next track');
  nextBtn.textContent = '\u23ED';

  controls.append(prevBtn, playPauseBtn, nextBtn);
  player.appendChild(controls);

  const seekRow = document.createElement('div');
  seekRow.className = 'art-player-seek-row';

  const currentTimeLabel = document.createElement('span');
  currentTimeLabel.className = 'art-player-time art-player-time-current';
  currentTimeLabel.textContent = '0:00';

  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'art-player-seek';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';

  const durationLabel = document.createElement('span');
  durationLabel.className = 'art-player-time art-player-time-duration';
  durationLabel.textContent = '0:00';

  seekRow.append(currentTimeLabel, seek, durationLabel);
  player.appendChild(seekRow);

  const volumeRow = document.createElement('div');
  volumeRow.className = 'art-player-volume-row';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'art-player-btn art-player-mute';
  muteBtn.setAttribute('aria-label', 'Mute');
  muteBtn.textContent = '\uD83D\uDD0A';

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'art-player-volume';
  volume.min = '0';
  volume.max = '100';
  volume.value = '100';
  volume.setAttribute('aria-label', 'Volume');

  volumeRow.append(muteBtn, volume);
  player.appendChild(volumeRow);

  const audio = document.createElement('audio');
  audio.className = 'art-player-audio';
  audio.preload = 'metadata';

  layout.appendChild(player);
  layout.appendChild(audio);

  const trackList = document.createElement('ul');
  trackList.className = 'art-track-list';

  const trackListItems = tracks.map((track, index) => {
    const item = document.createElement('li');
    item.className = 'art-track-list-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'art-track-list-btn';
    button.textContent = track.title || `Track ${index + 1}`;
    button.addEventListener('click', () => {
      if (index === trackIndex) return;
      loadTrack(index, true);
    });

    item.appendChild(button);
    trackList.appendChild(item);
    return item;
  });

  layout.appendChild(trackList);
  article.appendChild(layout);

  const trackSummary = document.createElement('div');
  trackSummary.className = 'art-track-summary';
  article.appendChild(trackSummary);

  let isSeeking = false;

  function updateButtonStates() {
    prevBtn.disabled = trackIndex === 0;
    nextBtn.disabled = trackIndex === tracks.length - 1;
    trackListItems.forEach((item, index) => {
      item.classList.toggle('active', index === trackIndex);
    });
  }

  function loadTrack(index, autoplay) {
    trackIndex = index;
    const track = tracks[trackIndex];
    audio.src = track.file;
    trackTitle.textContent = track.title || `Track ${trackIndex + 1}`;
    trackSummary.innerHTML = track.summary ? renderMarkdown(track.summary) : '';
    seek.value = '0';
    currentTimeLabel.textContent = '0:00';
    durationLabel.textContent = '0:00';
    updateButtonStates();
    if (autoplay) {
      audio.play();
    }
  }

  playPauseBtn.addEventListener('click', () => {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  });

  prevBtn.addEventListener('click', () => {
    if (trackIndex === 0) return;
    const wasPlaying = !audio.paused;
    loadTrack(trackIndex - 1, wasPlaying);
  });

  nextBtn.addEventListener('click', () => {
    if (trackIndex === tracks.length - 1) return;
    const wasPlaying = !audio.paused;
    loadTrack(trackIndex + 1, wasPlaying);
  });

  audio.addEventListener('play', () => {
    playPauseBtn.textContent = '\u23F8';
    playPauseBtn.setAttribute('aria-label', 'Pause');
  });

  audio.addEventListener('pause', () => {
    playPauseBtn.textContent = '\u25B6';
    playPauseBtn.setAttribute('aria-label', 'Play');
  });

  let lastVolume = 1;

  function updateMuteButton() {
    if (audio.muted || audio.volume === 0) {
      muteBtn.textContent = '\uD83D\uDD07';
      muteBtn.setAttribute('aria-label', 'Unmute');
    } else {
      muteBtn.textContent = '\uD83D\uDD0A';
      muteBtn.setAttribute('aria-label', 'Mute');
    }
  }

  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value) / 100;
    audio.muted = audio.volume === 0;
    if (audio.volume > 0) lastVolume = audio.volume;
    updateMuteButton();
  });

  muteBtn.addEventListener('click', () => {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      audio.volume = lastVolume || 1;
      volume.value = String(Math.round(audio.volume * 100));
    } else {
      lastVolume = audio.volume;
      audio.muted = true;
      volume.value = '0';
    }
    updateMuteButton();
  });

  audio.addEventListener('loadedmetadata', () => {
    durationLabel.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    currentTimeLabel.textContent = formatTime(audio.currentTime);
    if (audio.duration) {
      seek.value = String((audio.currentTime / audio.duration) * 1000);
    }
  });

  audio.addEventListener('ended', () => {
    if (trackIndex < tracks.length - 1) {
      loadTrack(trackIndex + 1, true);
    }
  });

  seek.addEventListener('input', () => {
    isSeeking = true;
    if (audio.duration) {
      currentTimeLabel.textContent = formatTime((Number(seek.value) / 1000) * audio.duration);
    }
  });

  seek.addEventListener('change', () => {
    if (audio.duration) {
      audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    }
    isSeeking = false;
  });

  loadTrack(0, false);
}

function buildImageCarousel(article, detail) {
  const images = detail.images || [];
  if (!images.length) return;

  let imageIndex = 0;

  const carousel = document.createElement('div');
  carousel.className = 'art-carousel';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'art-carousel-arrow art-carousel-prev';
  prevBtn.setAttribute('aria-label', 'Previous image');
  prevBtn.textContent = '\u2190';

  const imageWrap = document.createElement('div');
  imageWrap.className = 'art-carousel-image-wrap';

  const img = document.createElement('img');
  img.className = 'art-carousel-image';
  imageWrap.appendChild(img);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'art-carousel-arrow art-carousel-next';
  nextBtn.setAttribute('aria-label', 'Next image');
  nextBtn.textContent = '\u2192';

  if (images.length > 1) {
    carousel.append(prevBtn, imageWrap, nextBtn);
  } else {
    carousel.append(imageWrap);
  }

  article.appendChild(carousel);

  const imageSummary = document.createElement('div');
  imageSummary.className = 'art-carousel-summary';
  article.appendChild(imageSummary);

  function render() {
    const image = images[imageIndex];
    img.src = image.file;
    img.alt = image.alt || detail.title;
    imageSummary.innerHTML = image.summary ? renderMarkdown(image.summary) : '';
    prevBtn.disabled = imageIndex === 0;
    nextBtn.disabled = imageIndex === images.length - 1;
  }

  prevBtn.addEventListener('click', () => {
    if (imageIndex === 0) return;
    imageIndex--;
    render();
  });

  nextBtn.addEventListener('click', () => {
    if (imageIndex === images.length - 1) return;
    imageIndex++;
    render();
  });

  render();
}
