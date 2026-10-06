declare module "level" {
  export interface LevelDB {
    open(): Promise<void>;
    close(): Promise<void>;
    get(key: string): Promise<any>;
    put(key: string, value: any): Promise<void>;
    del(key: string): Promise<void>;
    batch(ops: any[]): Promise<void>;
    iterator(options?: any): any;
    sublevel(name: string, options?: any): any;
    [key: string]: any;
  }
  export default function level(location: string, options?: any): any;
}
