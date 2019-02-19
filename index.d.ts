import {Connection} from "amqplib";

interface RemitConstructorOptions {
    exchange?: string;
    name?: string;
    url?: string;
    connection?: Connection;
    errorHandler?: (error: Error) => Promise<void>;
}

declare function remit(options?: RemitConstructorOptions): remit.Remit;

declare namespace remit {
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

    export interface EmitterOptions {
        schedule?: Date;
        delay?: number;
        persistent?: boolean;
        priority?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
        event?: string;
    }

    export type Emitter = (data: any, options?: EmitterOptions) => Promise<void>;

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
