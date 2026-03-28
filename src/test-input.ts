import { createCliRenderer, Box, Text, Input, InputRenderableEvents } from "@opentui/core"

async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useAlternateScreen: true });
  
  const logs: string[] = [];
  function log(msg: string) {
    logs.push(msg);
    require('fs').appendFileSync('/tmp/opentui-test.log', msg + '\n');
  }
  
  const root = Box({ width: '100%', height: '100%', flexDirection: 'column' });
  root.add(Text({ content: ' Test App - Press Enter to submit', fg: '#00ff00' }));
  
  const chat = Box({ width: '100%', flexGrow: 1, flexDirection: 'column', padding: 1 });
  root.add(chat);
  
  const input = Input({
    id: 'test-input',
    width: '100%',
    placeholder: 'Type here and press Enter...',
    textColor: '#ffffff',
    cursorColor: '#00ff00',
  });
  root.add(input);
  
  renderer.root.add(root);
  
  // Listen for Enter
  input.on(InputRenderableEvents.ENTER, (value: string) => {
    log(`ENTER event: "${value}"`);
    chat.add(Text({ content: `ENTER: ${value}`, fg: '#00ff00' }));
  });
  
  // Also try keypress
  renderer.keyInput.on('keypress', (key) => {
    log(`keypress: ${key.name}`);
    if (key.name === 'return') {
      chat.add(Text({ content: `RETURN pressed`, fg: '#ffff00' }));
    }
  });
  
  input.focus();
  log('App started');
}

main().catch(e => require('fs').appendFileSync('/tmp/opentui-test.log', 'Error: ' + e.message + '\n'));
