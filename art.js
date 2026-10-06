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

const VOLUME_STORAGE_KEY = 'art-player-volume';

function getStoredVolume() {
  const stored = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= 0 && stored <= 100 ? stored : 100;
}

function setStoredVolume(value) {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(value));
  } catch (err) {
    // localStorage may be unavailable (e.g. private browsing); ignore.
  }
}

function buildMusicPlayer(article, detail) {
  const tracks = detail.tracks || [];
  if (!tracks.length) return;

  let trackIndex = 0;

  const player = document.createElement('div');
  player.className = 'art-player';

  const topSection = document.createElement('div');
  topSection.className = 'art-player-section';

  const titleRow = document.createElement('div');
  titleRow.className = 'art-player-title-row';

  const trackTitle = document.createElement('div');
  trackTitle.className = 'art-player-track-title';

  const trackTitleInner = document.createElement('span');
  trackTitleInner.className = 'art-player-track-title-inner';
  trackTitle.appendChild(trackTitleInner);

  const skipGroup = document.createElement('div');
  skipGroup.className = 'art-player-skip-group';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'art-player-icon-btn art-player-prev';
  prevBtn.setAttribute('aria-label', 'Previous track');

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'art-player-icon-btn art-player-next';
  nextBtn.setAttribute('aria-label', 'Next track');

  skipGroup.append(prevBtn, nextBtn);
  titleRow.append(trackTitle, skipGroup);
  topSection.appendChild(titleRow);

  const transportRow = document.createElement('div');
  transportRow.className = 'art-player-transport-row';

  const playPauseBtn = document.createElement('button');
  playPauseBtn.type = 'button';
  playPauseBtn.className = 'art-player-icon-btn art-player-playpause';
  playPauseBtn.setAttribute('aria-label', 'Play');

  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'art-player-seek';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek');

  const timeLabel = document.createElement('span');
  timeLabel.className = 'art-player-time';
  timeLabel.textContent = '0:00 / 0:00';

  transportRow.append(playPauseBtn, seek, timeLabel);
  topSection.appendChild(transportRow);
  player.appendChild(topSection);

  const volumeSection = document.createElement('div');
  volumeSection.className = 'art-player-section art-player-volume-row';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'art-player-icon-btn art-player-mute';
  muteBtn.setAttribute('aria-label', 'Mute');

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'art-player-volume';
  volume.min = '0';
  volume.max = '100';
  volume.value = String(getStoredVolume());
  volume.setAttribute('aria-label', 'Volume');

  volumeSection.append(muteBtn, volume);
  player.appendChild(volumeSection);

  const audio = document.createElement('audio');
  audio.className = 'art-player-audio';
  audio.preload = 'metadata';
  player.appendChild(audio);

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

  player.appendChild(trackList);
  article.appendChild(player);

  const trackSummary = document.createElement('div');
  trackSummary.className = 'art-track-summary';
  article.appendChild(trackSummary);

  let isSeeking = false;

  function updateTitleMarquee() {
    trackTitle.classList.remove('is-marquee');
    trackTitle.style.removeProperty('--marquee-distance');
    requestAnimationFrame(() => {
      const overflow = trackTitleInner.scrollWidth - trackTitle.clientWidth;
      if (overflow > 4) {
        trackTitle.style.setProperty('--marquee-distance', `-${overflow}px`);
        trackTitle.classList.add('is-marquee');
      }
    });
  }

  window.addEventListener('resize', updateTitleMarquee);

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
    trackTitleInner.textContent = track.title || `Track ${trackIndex + 1}`;
    updateTitleMarquee();
    trackSummary.innerHTML = track.summary ? renderMarkdown(track.summary) : '';
    seek.value = '0';
    timeLabel.textContent = '0:00 / 0:00';
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
    playPauseBtn.classList.add('is-playing');
    playPauseBtn.setAttribute('aria-label', 'Pause');
  });

  audio.addEventListener('pause', () => {
    playPauseBtn.classList.remove('is-playing');
    playPauseBtn.setAttribute('aria-label', 'Play');
  });

  audio.volume = Number(volume.value) / 100;
  let lastVolume = audio.volume || 1;

  function updateMuteButton() {
    const isMuted = audio.muted || audio.volume === 0;
    muteBtn.classList.toggle('is-muted', isMuted);
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  }

  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value) / 100;
    audio.muted = audio.volume === 0;
    if (audio.volume > 0) lastVolume = audio.volume;
    setStoredVolume(volume.value);
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
    setStoredVolume(volume.value);
    updateMuteButton();
  });

  audio.addEventListener('loadedmetadata', () => {
    timeLabel.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
  });

  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    timeLabel.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
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
      timeLabel.textContent = `${formatTime((Number(seek.value) / 1000) * audio.duration)} / ${formatTime(audio.duration)}`;
    }
  });

  seek.addEventListener('change', () => {
    if (audio.duration) {
      audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    }
    isSeeking = false;
  });

  loadTrack(0, false);
  updateMuteButton();
}

function buildImageCarousel(article, detail) {
  const images = detail.images || [];
  if (!images.length) return;

  let imageIndex = 0;
  const mobileView = window.matchMedia('(max-width: 767px)');

  const layout = document.createElement('div');
  layout.className = 'art-carousel-layout';

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'art-carousel-arrow art-carousel-prev';
  prevButton.setAttribute('aria-label', 'Previous image');
  prevButton.title = 'Previous image';
  prevButton.textContent = '\u2190';

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'art-carousel-arrow art-carousel-next';
  nextButton.setAttribute('aria-label', 'Next image');
  nextButton.title = 'Next image';
  nextButton.textContent = '\u2192';

  const carousel = document.createElement('div');
  carousel.className = 'art-carousel';
  carousel.setAttribute('aria-label', 'Artwork gallery');
  carousel.setAttribute('role', 'region');

  const slides = images.map((image, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'art-carousel-image-wrap';
    button.setAttribute('aria-label', `View full-size image ${index + 1} of ${images.length}`);
    const img = document.createElement('img');
    img.className = 'art-carousel-image';
    img.src = image.file;
    img.alt = image.alt || detail.title;
    img.addEventListener('load', () => {
      if (index === imageIndex) updateHeight();
    });
    button.appendChild(img);
    carousel.appendChild(button);
    return button;
  });

  const lightbox = document.createElement('dialog');
  lightbox.className = 'art-lightbox';
  lightbox.setAttribute('aria-label', 'Full-size artwork');

  const fullImage = document.createElement('img');
  fullImage.className = 'art-lightbox-image';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'art-lightbox-close';
  closeButton.textContent = '\u00D7';
  closeButton.setAttribute('aria-label', 'Close image');
  closeButton.title = 'Close image';
  lightbox.append(fullImage, closeButton);
  article.appendChild(lightbox);

  slides.forEach((button) => {
    button.addEventListener('click', () => {
      if (!mobileView.matches) return;
      const img = button.querySelector('img');
      fullImage.src = img.src;
      fullImage.alt = img.alt;
      lightbox.showModal();
      document.body.classList.add('art-lightbox-open');
    });
  });
  closeButton.addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      lightbox.close();
    }
  });
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener('close', () => {
    document.body.classList.remove('art-lightbox-open');
    slides[imageIndex].focus({ preventScroll: true });
  });

  if (images.length > 1) {
    layout.append(prevButton, carousel, nextButton);
  } else {
    layout.appendChild(carousel);
  }
  article.appendChild(layout);

  const imageSummary = document.createElement('div');
  imageSummary.className = 'art-carousel-summary';
  imageSummary.setAttribute('aria-live', 'polite');
  article.appendChild(imageSummary);

  function updateHeight() {
    const img = slides[imageIndex].querySelector('img');
    if (!img.naturalWidth || !carousel.clientWidth) return;
    const limit = window.innerHeight * (mobileView.matches ? 0.5 : 0.9);
    carousel.style.height = `${Math.min(limit, carousel.clientWidth * img.naturalHeight / img.naturalWidth)}px`;
  }

  function render() {
    const image = images[imageIndex];
    slides.forEach((button, index) => {
      button.classList.toggle('is-active', index === imageIndex);
      button.disabled = !mobileView.matches;
    });
    prevButton.disabled = imageIndex === 0;
    nextButton.disabled = imageIndex === images.length - 1;
    imageSummary.innerHTML = image.summary ? renderMarkdown(image.summary) : '';
    updateHeight();
  }

  prevButton.addEventListener('click', () => {
    if (imageIndex === 0) return;
    imageIndex--;
    render();
  });
  nextButton.addEventListener('click', () => {
    if (imageIndex === images.length - 1) return;
    imageIndex++;
    render();
  });
  carousel.addEventListener('scroll', () => {
    if (!mobileView.matches) return;
    const index = Math.round(carousel.scrollLeft / carousel.clientWidth);
    if (index >= 0 && index < images.length && index !== imageIndex) {
      imageIndex = index;
      render();
    }
  });
  carousel.addEventListener('keydown', (event) => {
    if (!mobileView.matches) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    imageIndex = Math.max(0, Math.min(images.length - 1, imageIndex + (event.key === 'ArrowRight' ? 1 : -1)));
    carousel.scrollTo({ left: imageIndex * carousel.clientWidth });
    slides[imageIndex].focus({ preventScroll: true });
    render();
  });
  new ResizeObserver(() => {
    updateHeight();
    carousel.scrollLeft = mobileView.matches ? imageIndex * carousel.clientWidth : 0;
  }).observe(carousel);
  function updateView() {
    if (!mobileView.matches && lightbox.open) lightbox.close();
    render();
    carousel.scrollLeft = mobileView.matches ? imageIndex * carousel.clientWidth : 0;
  }
  mobileView.addEventListener('change', updateView);
  window.addEventListener('resize', updateView);

  render();
}
