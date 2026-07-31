import { type DecryptedMessage } from '@/sync/storageTypes';
import { type ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';

/**
 * Extracts plain text from markdown by removing formatting
 */
function stripMarkdown(text: string): string {
  return text
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold and italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '[code]')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Remove list markers
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    // Clean up multiple whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Gets a readable summary of tool calls
 */
function getToolSummary(tools: ToolCall[]): string {
  if (tools.length === 0) return 'Used tools';
  
  if (tools.length === 1) {
    const tool = tools[0];
    const toolName = tool.name;
    
    // Try to extract meaningful info from common tools
    switch (toolName) {
      case 'Edit':
      case 'Write':
        const filePath = tool.input?.target_file || tool.input?.file_path;
        return filePath ? `Edited ${filePath}` : `Used ${toolName}`;
      
      case 'Read':
        const readPath = tool.input?.target_file || tool.input?.file_path;
        return readPath ? `Read ${readPath}` : 'Read file';
      
      case 'Bash':
      case 'RunCommand':
      case 'CodexBash':
      case 'GeminiBash':
        const command = stringifyToolCommand(tool.input?.command);
        if (command) {
          return `Ran: ${command.length > 20 ? command.substring(0, 20) + '...' : command}`;
        }
        return 'Ran command';
      
      default:
        return `Used ${toolName}`;
    }
  }
  
  // Multiple tools
  const toolNames = tools.map(t => t.name).slice(0, 3);
  if (tools.length <= 3) {
    return `Used ${toolNames.join(', ')}`;
  } else {
    return `Used ${toolNames.join(', ')} and ${tools.length - 3} more`;
  }
}

/**
 * Extracts a readable preview from message content
 */
export function getMessagePreview(message: DecryptedMessage | null, maxLength: number = 50): string {
  if (!message?.content) {
    return 'No content';
  }

  const content = message.content;

  // User messages
  if (content.role === 'user') {
    if (content.content && content.content.type === 'text') {
      const plainText = stripMarkdown(content.content.text);
      return plainText.length > maxLength
        ? plainText.substring(0, maxLength) + '...'
        : plainText;
    }
    return 'User message';
  }

  // Agent messages - handle BOTH raw and processed formats
  if (content.role === 'agent') {
    // FIRST: Check if this is the processed Message format (simple structure)
    // This handles: {role: 'agent', content: {type: 'text', text: '...'}}
    if (content.content && typeof content.content === 'object') {
      if (content.content.type === 'text' && content.content.text) {
        const plainText = stripMarkdown(content.content.text);
        return plainText.length > maxLength
          ? plainText.substring(0, maxLength) + '...'
          : plainText;
      }
      
      if (content.content.type === 'tool' && content.content.tools) {
        return getToolSummary(content.content.tools);
      }
    }
    
    // Fallback for agent messages
    return 'Thinking...';
  }

  return 'Unknown message';
}

/**
 * Determines if a message is from the assistant/agent
 */
export function isMessageFromAssistant(message: DecryptedMessage | null): boolean {
  if (!message?.content) return false;
  return message.content.role === 'agent';
} 
