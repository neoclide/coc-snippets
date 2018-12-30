/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/

/**
 * A very basic parser
 *
 * @public
 */
export default class Parser {
  private _curr = 0
  constructor(private _content: string) {
  }

  eof(): boolean {
    return this._curr >= this._content.length
  }

  skipSpaces(): void {
    for (let i = this._curr; i <= this._content.length; i++) {
      let ch = this._content[i]
      if (!ch || /\S/.test(ch)) {
        this._curr = i
        break
      }
    }
  }

  get index(): number {
    return this._curr
  }

  get curr(): string | undefined {
    return this._content[this._curr] || ''
  }

  get len(): number {
    return this._content.length
  }

  next(count = 1): string {
    return this._content.slice(this._curr + 1, this._curr + 1 + count)
  }

  nextIndex(character: string, checkbackspace = true, allowEnd = true): number {
    if (this._curr >= this.len - 1) return allowEnd ? this.len - 1 : -1
    let i = this._curr + 1
    let pre = this.curr || ''
    while (i != this.len - 1) {
      let ch = this._content[i]
      if (ch == character && (!checkbackspace || pre !== '\\')) {
        break
      }
      pre = ch
      i = i + 1
    }
    if (!allowEnd && i == this.len - 1 && character != this._content[i]) {
      return -1
    }
    return i
  }

  prev(): string {
    return this._content[this._curr - 1] || ''
  }

  iterate(fn: (character: string, idx: number) => boolean): void {
    while (this._curr < this._content.length) {
      let fine = fn(this.curr, this._curr)
      if (fine === false) {
        break
      }
      this._curr = this._curr + 1
    }
  }

  eat(count: number): string {
    let end = this._curr + count
    let str = this._content.slice(this._curr, end)
    this._curr = end
    return str
  }

  // make curr to index, return contnet between curr (inclusive) and index (exclusive)
  eatTo(index: number): string {
    if (index == this._curr) return ''
    let str = this._content.slice(this._curr, index)
    this._curr = index
    return str
  }
}
