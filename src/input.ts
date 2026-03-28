import { Command } from './commands';
import * as readline from 'readline';

export interface InputResult {
  type: 'input' | 'command' | 'exit';
  value: string;
}

async function readInputFallback(commands: Command[]): Promise<InputResult> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('> ', (answer) => {
      rl.close();

      if (answer.toLowerCase() === 'exit' || answer.toLowerCase() === 'quit') {
        resolve({ type: 'exit', value: '' });
        return;
      }

      if (answer.startsWith('/')) {
        const cmdName = answer.slice(1);
        const cmd = commands.find(c => c.name === cmdName);
        if (cmd) {
          if (cmd.name === 'exit') {
            resolve({ type: 'exit', value: '' });
          } else {
            const result = cmd.action();
            if (result) console.log(result);
            resolve({ type: 'command', value: answer });
          }
          return;
        }
        
        console.log('  toggle-execute - Toggle shell command execution');
        console.log('  toggle-mcp - Toggle MCP tools');
        console.log('  help - Show available commands');
        console.log('  exit - Exit interactive mode');
        resolve({ type: 'command', value: '' });
        return;
      }

      resolve({ type: 'input', value: answer });
    });
  });
}

export async function readInput(commands: Command[]): Promise<InputResult> {
  if (!process.stdin.isTTY) {
    return readInputFallback(commands);
  }

  return new Promise((resolve) => {
    let buffer = '';
    let cursorPos = 0;
    let inCommandMode = false;
    let selectedIndex = 0;
    let filteredCommands = [...commands];
    let commandListLines = 0;

    function clearLines(count: number) {
      for (let i = 0; i < count; i++) {
        process.stdout.write('\x1b[1A\x1b[2K');
      }
    }

    function showPrompt() {
      const termWidth = process.stdout.columns || 80;
      const promptLen = 2;
      const totalLen = promptLen + buffer.length;
      const linesOccupied = Math.ceil(totalLen / termWidth);
      
      if (linesOccupied === 1) {
        process.stdout.write('\r\x1b[2K> ' + buffer);
        const moveBack = buffer.length - cursorPos;
        if (moveBack > 0) {
          process.stdout.write('\x1b[' + moveBack + 'D');
        }
      } else {
        // Multi-line: move up to first line, clear, then write
        if (inCommandMode) {
          // In command mode, clear lines individually to preserve command list
          process.stdout.write('\x1b[' + (linesOccupied - 1) + 'A\r');
          for (let i = 0; i < linesOccupied; i++) {
            process.stdout.write('\x1b[2K');
            if (i < linesOccupied - 1) {
              process.stdout.write('\x1b[1B');
            }
          }
          process.stdout.write('\x1b[' + (linesOccupied - 1) + 'A\r');
        } else {
          // Not in command mode, can clear to end of screen
          process.stdout.write('\x1b[' + (linesOccupied - 1) + 'A\r\x1b[J');
        }
        process.stdout.write('> ' + buffer);
      }
    }

    function printCommandList() {
      filteredCommands.forEach((cmd, index) => {
        if (index === selectedIndex) {
          process.stdout.write('\r\n\x1b[36m❯ ' + cmd.name + ' - ' + cmd.description + '\x1b[0m');
        } else {
          process.stdout.write('\r\n  ' + cmd.name + ' - ' + cmd.description);
        }
      });
      commandListLines = filteredCommands.length;
    }

    function showCommandList() {
      const linesToPrint = filteredCommands.length;
      if (linesToPrint > 0) {
        printCommandList();
        // Move cursor back to prompt line
        process.stdout.write('\x1b[' + linesToPrint + 'A');
      }
      showPrompt();
    }

    function clearCommandList() {
      if (commandListLines > 0) {
        // Clear all command lines (we're on prompt line)
        for (let i = 0; i < commandListLines; i++) {
          process.stdout.write('\n\r\x1b[2K');
        }
        // Move back up to prompt line
        process.stdout.write('\x1b[' + commandListLines + 'A');
        commandListLines = 0;
      }
    }

    function updateCommandList() {
      clearCommandList();
      showCommandList();
    }

    function filterCommands() {
      const filter = buffer.slice(1).toLowerCase();
      if (!filter) {
        filteredCommands = [...commands];
      } else {
        filteredCommands = commands.filter(cmd =>
          cmd.name.toLowerCase().includes(filter) ||
          cmd.description.toLowerCase().includes(filter)
        );
      }
      selectedIndex = Math.min(selectedIndex, Math.max(0, filteredCommands.length - 1));
    }

    function selectCommand() {
      if (filteredCommands.length > 0) {
        const selected = filteredCommands[selectedIndex];
        
        clearCommandList();
        process.stdin.setRawMode(false);
        process.stdin.removeAllListeners('data');
        process.stdout.write('\n');
        
        if (selected.name === 'exit') {
          resolve({ type: 'exit', value: '' });
        } else {
          const result = selected.action();
          if (result) console.log(result);
          resolve({ type: 'command', value: `/${selected.name}` });
        }
      }
    }

    function enterCommandMode() {
      inCommandMode = true;
      selectedIndex = 0;
      filteredCommands = [...commands];
      cursorPos = buffer.length;
      showCommandList();
    }

    function exitCommandMode() {
      clearCommandList();
      inCommandMode = false;
      buffer = '';
      cursorPos = 0;
      showPrompt();
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    showPrompt();

    process.stdin.on('data', (key: string | Buffer) => {
      const keyStr = typeof key === 'string' ? key : key.toString();
      const keyCode = typeof key === 'string' ? key.charCodeAt(0) : (key as Buffer)[0];

      // Ctrl+C
      if (keyCode === 3) {
        clearCommandList();
        process.stdin.setRawMode(false);
        process.stdin.removeAllListeners('data');
        process.stdout.write('\n');
        resolve({ type: 'exit', value: '' });
        return;
      }

      // ESC
      if (keyCode === 27 && keyStr.length === 1) {
        if (inCommandMode) {
          exitCommandMode();
        }
        return;
      }

      // Arrow Up
      if (keyStr === '\x1b[A') {
        if (inCommandMode && selectedIndex > 0) {
          selectedIndex--;
          updateCommandList();
        }
        return;
      }

      // Arrow Down
      if (keyStr === '\x1b[B') {
        if (inCommandMode && selectedIndex < filteredCommands.length - 1) {
          selectedIndex++;
          updateCommandList();
        }
        return;
      }

      // Arrow Left
      if (keyStr === '\x1b[D') {
        if (cursorPos > 0) {
          cursorPos--;
          showPrompt();
        }
        return;
      }

      // Arrow Right
      if (keyStr === '\x1b[C') {
        if (cursorPos < buffer.length) {
          cursorPos++;
          showPrompt();
        }
        return;
      }

      // Ignore other escape sequences
      if (keyStr.startsWith('\x1b')) {
        return;
      }

      // Enter
      if (keyCode === 13) {
        if (inCommandMode) {
          selectCommand();
          return;
        }

        clearCommandList();
        process.stdin.setRawMode(false);
        process.stdin.removeAllListeners('data');
        process.stdout.write('\n');

        const input = buffer;

        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
          resolve({ type: 'exit', value: '' });
          return;
        }

        if (input.startsWith('/')) {
          const cmdName = input.slice(1);
          const cmd = commands.find(c => c.name === cmdName);
          if (cmd) {
            if (cmd.name === 'exit') {
              resolve({ type: 'exit', value: '' });
            } else {
              const result = cmd.action();
              if (result) console.log(result);
              resolve({ type: 'command', value: input });
            }
            return;
          }
        }

        resolve({ type: 'input', value: input });
        return;
      }

      // Backspace
      if (keyCode === 127 || keyCode === 8) {
        if (cursorPos > 0) {
          buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
          cursorPos--;
          
          if (inCommandMode) {
            if (buffer === '') {
              exitCommandMode();
            } else {
              filterCommands();
              updateCommandList();
            }
          } else {
            showPrompt();
          }
        }
        return;
      }

      // Regular character
      if (keyStr.length === 1 && keyCode >= 32 && keyCode < 127) {
        buffer = buffer.slice(0, cursorPos) + keyStr + buffer.slice(cursorPos);
        cursorPos++;

        if (buffer === '/' && !inCommandMode) {
          enterCommandMode();
          return;
        }

        if (inCommandMode) {
          filterCommands();
          updateCommandList();
        } else {
          showPrompt();
        }
        return;
      }
    });
  });
}
