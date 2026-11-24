import { Client, type ClientOptions } from "@modelcontextprotocol/client";

export interface McpClientFactoryOptions {
  clientName?: string;
  clientVersion?: string;
  clientOptions?: ClientOptions;
}

export class McpClientFactory {
  /**
   * Instantiates an official MCP SDK Client configured with Messiah metadata.
   * Following the MCP 2026-07-28 specification, client operates statelessly with
   * deprecated capabilities (roots, sampling, logging) omitted from default capabilities.
   */
  public static createClient(options: McpClientFactoryOptions = {}): Client {
    const {
      clientName = "messiah",
      clientVersion = "1.0.0",
      clientOptions = {},
    } = options;

    return new Client(
      {
        name: clientName,
        version: clientVersion,
      },
      {
        capabilities: clientOptions.capabilities || {},
        ...clientOptions,
      }
    );
  }
}
