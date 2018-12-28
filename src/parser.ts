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

  nextIndex(character: string, checkbackspace = true): number {
    if (this._curr >= this.len - 1) return 0
    let i = 1
    let pre = this.curr || ''
    while (pre != null) {
      let ch = this._content[this._curr + i]
      if (ch == null) {
        break
      } else if (ch == character && (!checkbackspace || pre !== '\\')) {
        break
      }
      pre = ch
      i = i + 1
    }
    return i
  }

  iterate(fn: (character: string) => boolean): void {
    while (this._curr <= this._content.length) {
      let cont = fn(this.curr)
      if (!cont) {
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
}
