import OpenAI from 'openai';
import { config } from './config.js';
import { ChatCompletion } from 'openai/resources';
import { Pool } from 'pg'

const API_KEY = 'API_KEY';
const CONNECTION_STRING = 'CONNECTION_STRING';


interface Message {
  role: string;
  content: string;
  tool_call_id?: string | null;
  name?: string | null;
}

interface Completion {
  Content: string | null;
  Error?: string | undefined;
  TokenUsage: number | undefined;
  ToolCalls?: any; // Add this line to include tool calls
}

interface ConnectorResponse {
  Completions: Completion[];
  ModelType: string;
}

interface ErrorCompletion {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  error: string;
  model: string;
  usage: undefined;
}

const mapToResponse = (
  outputs: Array<ChatCompletion | ErrorCompletion>,
  model: string,
): ConnectorResponse => {
  return {
    Completions: outputs.map((output) => {
      if ('error' in output) {
        return {
          Content: null,
          TokenUsage: undefined,
          Error: output.error,
        };
      } else {
        return {
          Content: output.choices[0]?.message?.content,
          TokenUsage: output.usage?.total_tokens,
        };
      }
    }),
    ModelType: outputs[0].model || model,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapErrorToCompletion = (error: any, model: string): ErrorCompletion => {
  const errorMessage = error.message || JSON.stringify(error);
  return {
    choices: [],
    error: errorMessage,
    model,
    usage: undefined,
  };
};

// Test function to query data from the database
async function testDatabaseQuery(query: string, connectionString: string) {
  console.log('Connecting to database');
  console.log(query);
  console.log(connectionString);

  // Create a new pool instance using the connection string and SSL options
  const pool = new Pool({
    connectionString: connectionString,
    ssl: {
      rejectUnauthorized: false, // Disable certificate verification
    },
  });

  try {
    console.log('Executing database query:', query);
    // Connect to the database and execute the query
    const client = await pool.connect();
    try {
      const res = await client.query(query);
      return res.rows;
    } finally {
      client.release(); // Release the database client back to the pool
    }
  } catch (error) {
    console.error('Database query failed:', error);
    throw error; // Rethrow the error after logging
  } finally {
    pool.end(); // Close the pool to exit cleanly after running the query
  }
}

async function main(
  model: string,
  prompts: string[],
  properties: Record<string, unknown>,
  settings: Record<string, unknown>,
) {
  const openai = new OpenAI({
    apiKey: settings?.[API_KEY] as string,
  });

  const total = prompts.length;
  const { prompt, ...restProperties } = properties;
  const systemPrompt = (prompt ||
    config.properties.find((prop) => prop.id === 'prompt')?.value) as string;
  const messageHistory: Message[] = [{ role: 'system', content: systemPrompt }];
  const outputs: Array<ChatCompletion | ErrorCompletion> = [];

  const tools = [
    {
      type: 'function',
      function: {
        name: 'testDatabaseQuery',
        description: 'Execute a database query',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The SQL query to execute',
            },
          },
          required: ['query'],
        },
      },
    },
  ];

  try {
    for (let index = 0; index < total; index++) {
      try {
        messageHistory.push({ role: 'user', content: prompts[index] });
        const chatCompletion = await openai.chat.completions.create({
          messages: messageHistory as unknown as [],
          model,
          tools: tools.map(tool => ({ type: "function", function: tool.function })),
          tool_choice: "auto",
          ...restProperties,
        });

        const assistantResponse = chatCompletion.choices[0].message.content || 'No response.';
        messageHistory.push({ role: 'assistant', content: assistantResponse });

        // Check if the assistant's response contains a tool call
        const toolCalls = chatCompletion.choices[0].message.tool_calls;
        if (toolCalls) {
          for (const toolCall of toolCalls) {
            if (toolCall.function.name === 'testDatabaseQuery') {
              const functionArgs = JSON.parse(toolCall.function.arguments);
              const connectionString = settings?.[CONNECTION_STRING] as string;
              const functionResponse = await testDatabaseQuery(functionArgs.query, connectionString);
              messageHistory.push({
                tool_call_id: toolCall.id,
                role: 'function',
                name: 'testDatabaseQuery',
                content: JSON.stringify(functionResponse),
              });
            }
          }
          const secondResponse = await openai.chat.completions.create({
            model: model,
            messages: messageHistory as unknown as [],
            ...restProperties,
          });
          const secondAssistantResponse = secondResponse.choices[0].message.content || 'No response.';
          outputs.push(secondResponse);
          messageHistory.push({ role: 'assistant', content: secondAssistantResponse });
        } else {
          outputs.push(chatCompletion);
        }

      } catch (error) {
        console.error('Error in main loop:', error);
        const completionWithError = mapErrorToCompletion(error, model);
        outputs.push(completionWithError);
      }
    }

    return mapToResponse(outputs, model);
  } catch (error) {
    console.error('Error in main function:', error);
    return { Error: error, ModelType: model };
  }
}

export { main, config };