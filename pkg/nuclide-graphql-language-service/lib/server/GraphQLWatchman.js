/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 */

import type {Uri} from '../types/Types';

import watchman from 'fb-watchman';

type WatchmanCommandResponse = {
  version: string,
  relative_path: Uri,
  watcher: string,
  watch: Uri,
};

export class GraphQLWatchman {
  _client: watchman.Client;
  constructor() {
    this._client = new watchman.Client();
  }

  checkVersion(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._client.capabilityCheck({
        optional: [],
        required: ['relative_roots', 'cmd-watch-project'],
      }, (error, response) => {
        if (error) {
          reject(error);
        } else {
          // From the Watchman docs, response is something like:
          // {'version': '3.8.0', 'capabilities': {'relative_root': true}}.
          resolve();
        }
      });
    });
  }

  async listFiles(
    entryPath: Uri,
    options?: {[name: string]: any} = {},
  ): Promise<Array<any>> {
    const {watch, relative_path} = await this.watchProject(entryPath);
    const result = await this.runCommand('query', watch, {
      expression: [
        'allof',
        ['match', '*.graphql'],
        ['exists'],
      ],
      // Providing `path` will let watchman use path generator, and will perform
      // a tree walk with respect to the relative_root and path provided.
      // Path generator will do less work unless the root path of the repository
      // is passed in as an entry path.
      fields: ['name', 'size', 'mtime'],
      relative_root: relative_path,
      ...options,
    });
    return result.files;
  }

  runCommand(...args: Array<any>): Promise<any> {
    return new Promise((resolve, reject) =>
      this._client.command(args, (error, response) => {
        if (error) {
          reject(error);
        }
        resolve(response);
      }),
    ).catch(error => {
      throw new Error(error);
    });
  }

  async watchProject(directoryPath: Uri): Promise<WatchmanCommandResponse> {
    const response = await this.runCommand(
      'watch-project',
      directoryPath,
    );

    return response;
  }

  async subscribe(
    entryPath: Uri,
    callback: (result: Object) => void,
  ): Promise<void> {
    const {watch, relative_path} = await this.watchProject(entryPath);

    // Subscribe to the relative path
    await this.runCommand('subscribe', watch, relative_path, {
      expression: [
        'allof',
        ['match', '*.graphql'],
      ],
      fields: ['name', 'exists', 'size', 'mtime'],
      relative_root: relative_path,
    });

    this._client.on('subscription', result => {
      if (result.subscription !== relative_path) {
        return;
      }
      callback(result);
    });
  }

  dispose() {
    this._client.end();
    this._client = null;
  }
}