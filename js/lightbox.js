/**
 * Tap any article image to see it full-screen, like X. The viewer shows the image already loaded
 * in the article (original resolution), scaled to fit the screen. With several images, ←/→ or the
 * side buttons move between them. Esc, × or a tap anywhere else closes it.
 */
const ARTICLE_IMAGES = '#article-header .article-images img, #article-body img';

export class ImageViewer {
  constructor({ dialog }) {
    this.dialog = dialog;
    this.image = dialog.querySelector('#viewer-image');
    this.count = dialog.querySelector('#viewer-count');
    this.previous = dialog.querySelector('.viewer-prev');
    this.next = dialog.querySelector('.viewer-next');
    this.images = [];
    this.index = 0;
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      const image = target?.closest('img');
      if (!image || !image.matches(ARTICLE_IMAGES) || !image.getAttribute('src')) return;
      event.preventDefault();
      this.open(image);
    });
    this.previous.addEventListener('click', event => { event.stopPropagation(); this.step(-1); });
    this.next.addEventListener('click', event => { event.stopPropagation(); this.step(1); });
    dialog.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('button')) dialog.close();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    });
    dialog.addEventListener('close', () => { this.image.removeAttribute('src'); this.images = []; });
  }

  open(image) {
    this.images = [...document.querySelectorAll(ARTICLE_IMAGES)].filter(img => img.getAttribute('src'));
    this.index = Math.max(0, this.images.indexOf(image));
    this.show();
    if (!this.dialog.open) this.dialog.showModal();
  }

  show() {
    const source = this.images[this.index];
    if (!source) return;
    this.image.src = source.currentSrc || source.src;
    this.image.alt = source.alt || 'Article image';
    const several = this.images.length > 1;
    this.previous.hidden = !several;
    this.next.hidden = !several;
    this.previous.disabled = this.index === 0;
    this.next.disabled = this.index === this.images.length - 1;
    this.count.textContent = several ? `${this.index + 1} / ${this.images.length}` : '';
  }

  step(delta) {
    const index = this.index + delta;
    if (index < 0 || index >= this.images.length) return;
    this.index = index;
    this.show();
  }
}
