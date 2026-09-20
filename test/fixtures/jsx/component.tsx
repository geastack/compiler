// A function component element: the one JSX form the checker resolves as a
// call. `<Row label="a" width={n}/>` builds `{label: 'a', width: n}` and calls
// `Row` with it, which is exactly what TypeScript checked, so it needs no
// element recipe of its own.

interface RowProps {
  label: string
  width: number
}

function Row(props: RowProps) {
  return (
    <text id={props.label} width={props.width}>
      {props.label}
    </text>
  )
}

const columns = 3

export const row = <Row label="left" width={columns} />
