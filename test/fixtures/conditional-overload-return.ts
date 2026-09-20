class Reader {
  read<const Required extends boolean = false>(required?: Required): Required extends true ? number : number | null
  read(required = false): number | null {
    return required ? 17 : null
  }
}

const reader = new Reader()
console.log(reader.read() === null, reader.read(true))
