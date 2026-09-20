const greeting: string = 'hello'
const greetingLength: number = greeting.length
const isEmpty: boolean = greetingLength === 0

class Message {
  text: string = 'hi'

  isBlank(): boolean {
    return this.text.length === 0
  }
}

const message: Message = new Message()
const blank: boolean = message.isBlank()
