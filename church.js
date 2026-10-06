const churchImages = [
  './assets/img/church/angel.webp',
  './assets/img/church/hourglass.webp',
  './assets/img/church/love-letter.webp',
  './assets/img/church/blessed-is-the-machine.webp',
  './assets/img/church/mother.webp',
  './assets/img/church/questions.webp',
  './assets/img/church/real.webp',
  './assets/img/church/reality.webp',
  './assets/img/church/obscurity.png',
];

const churchImage = document.querySelector('.church-image');
const randomizeButton = document.querySelector('#church-randomize');

function showRandomChurchImage() {
  const currentImage = churchImage.getAttribute('src');
  const availableImages = churchImages.filter((image) => image !== currentImage);
  const randomIndex = Math.floor(Math.random() * availableImages.length);

  churchImage.src = availableImages[randomIndex];
}

randomizeButton.addEventListener('click', showRandomChurchImage);
showRandomChurchImage();