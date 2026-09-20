import { Component } from './jsx-runtime.js'

interface HeaderProps {
  title: string
}

class Header extends Component<HeaderProps> {
  template(props: HeaderProps) {
    return <span id="header">{props.title}</span>
  }
}

export const page = (
  <div id="page">
    <Header title="hello" />
  </div>
)
