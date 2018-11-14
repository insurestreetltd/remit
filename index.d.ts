import {Connection} from "amqplib";

declare module "remit" {
  interface RemitOptions {
    exchange?: string;
    name?: string;
    url?: string;
    connection?: Connection;
  }

  function remit(options?: RemitOptions): remit.Remit;

  namespace remit {
    export interface Event {
      data?: any;
      error?: Error;
      status?: boolean;
    }

    export type Handler = (event: Event) => void;

    export interface Endpoint {
      handler(...handlers: Handler[]): Endpoint;

      pause(cold: boolean): Promise<Endpoint>;

      resume(): Promise<Endpoint>;

      start(): Promise<void>;
    }

    export interface Listener {
      handler(...handlers: Handler[]): Listener;

      start(): Promise<void>;

      stop(): Promise<void>;
    }

    export type Emitter = (data: any) => Promise<void>;

    export interface Remit {
      request(endpointName: string): (args?: any) => Promise<any>;

      endpoint(endpointName: string, handler: Handler): Endpoint;

      listen(opts: {
        event: string;
        queue?: string;
        prefetch?: number;
        subscribe?: boolean;
      }): Listener;

      emit(opts: {event: string; delay?: number}): Emitter;
    }
  }

  export = remit;
}
