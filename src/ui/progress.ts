export class ProgressDisplay {
  private elem: HTMLDivElement;

  constructor(elem: HTMLDivElement) {
    this.elem = elem;
  }

  add(msg: string): void {
    this.elem.innerHTML += msg + '<br>';
    this.elem.scrollTo(0, this.elem.scrollHeight);
  }

  clear(): void {
    this.elem.innerHTML = '';
    this.elem.classList.remove('active');
  }

  setActive(active: boolean): void {
    if (active) this.elem.classList.add('active');
    else this.elem.classList.remove('active');
  }

  getElement(): HTMLDivElement {
    return this.elem;
  }
}