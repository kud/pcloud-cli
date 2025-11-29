#!/usr/bin/env node
import { Command } from 'commander';
import dotenv from 'dotenv';
import { PCloudAPI } from './api';
import { PCloudTrashItem } from './types';
import { TokenStore } from './token-store';
import { OAuthFlow } from './oauth';

dotenv.config();

const program = new Command();
const tokenStore = new TokenStore();

program
  .name('pcloud-cli')
  .description('CLI tool for pCloud file operations')
  .version('1.0.0');

async function getAuthenticatedAPI(): Promise<PCloudAPI> {
  // Option 1: Check for direct access token from env
  const accessToken = process.env.PCLOUD_ACCESS_TOKEN;
  if (accessToken) {
    const api = new PCloudAPI();
    api.setAccessToken(accessToken);
    return api;
  }

  // Option 2: Check for stored token
  const tokens = tokenStore.load();
  if (tokens) {
    const api = new PCloudAPI(tokens.apiServer);
    api.setAccessToken(tokens.accessToken, tokens.apiServer);
    return api;
  }

  // No authentication - prompt user with friendly message
  console.error('\n❌ Not authenticated!\n');
  console.error('It looks like you haven\'t set up pCloud CLI yet.\n');
  console.error('Please run this command first:\n');
  console.error('  npm start login\n');
  console.error('This is a one-time setup that takes less than a minute.\n');
  process.exit(1);
}

program
  .command('login')
  .description('Set up authentication with pCloud')
  .action(async () => {
    try {
      console.log('\n🔐 Welcome to pCloud CLI Setup!\n');
      console.log('You will be redirected to pCloud in your browser to log in.');
      console.log('After logging in, you\'ll be redirected back automatically.\n');

      const oauth = new OAuthFlow();
      const tokens = await oauth.authenticate();

      console.log('\n✓ Authentication successful!');

      // Save the token
      tokenStore.save({
        accessToken: tokens.accessToken,
        apiServer: tokens.apiServer,
      });

      console.log('\n🎉 Setup complete!');
      console.log('   Your access has been saved securely.');
      console.log('   You can now use all pCloud CLI commands.\n');
      console.log('Try: npm start list-trash\n');
    } catch (error) {
      console.error('\n❌ Authentication failed.');
      console.error(`   ${error instanceof Error ? error.message : 'Unknown error'}\n`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => {
    if (tokenStore.exists()) {
      tokenStore.delete();
      console.log('✓ Logged out successfully');
    } else {
      console.log('No stored credentials found');
    }
  });

program
  .command('list-trash')
  .description('List files in trash')
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI();
      const response = await api.listTrash();

      if (response.result !== 0) {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exit(1);
      }

      if (!response.contents || response.contents.length === 0) {
        console.log('Trash is empty');
        return;
      }

      console.log('\nFiles in trash:');
      console.log('================');
      response.contents.forEach((item: PCloudTrashItem) => {
        const date = new Date(item.deletetime * 1000).toLocaleString();
        console.log(`\nFile ID: ${item.fileid}`);
        console.log(`Name: ${item.name}`);
        console.log(`Path: ${item.path}`);
        console.log(`Deleted: ${date}`);
        if (item.size) console.log(`Size: ${formatBytes(item.size)}`);
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program
  .command('restore-trash')
  .description('Restore a file from trash')
  .argument('<fileid>', 'File ID to restore')
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI();
      const response = await api.restoreFromTrash(parseInt(fileid, 10));

      if (response.result !== 0) {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exit(1);
      }

      console.log(`✓ Successfully restored file ${fileid}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program
  .command('list-rewind')
  .description('List rewind events for a path')
  .argument('<path>', 'Path to check (e.g., /myfile.txt)')
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI();
      const response = await api.listRewindFiles(path);

      if (response.result !== 0) {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exit(1);
      }

      if (!response.contents || response.contents.length === 0) {
        console.log('No rewind events found');
        return;
      }

      console.log(`\nRewind events for ${path}:`);
      console.log('================');
      response.contents.forEach((item: any) => {
        const date = new Date(item.time * 1000).toLocaleString();
        console.log(`\nFile ID: ${item.fileid}`);
        console.log(`Name: ${item.name}`);
        console.log(`Time: ${date}`);
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

program
  .command('restore-rewind')
  .description('Restore a file from rewind')
  .argument('<fileid>', 'File ID to restore')
  .argument('<topath>', 'Destination path (e.g., /restored-file.txt)')
  .action(async (fileid: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI();
      const response = await api.restoreFromRewind(parseInt(fileid, 10), topath);

      if (response.result !== 0) {
        console.error(`Error: ${response.error || 'Unknown error'}`);
        process.exit(1);
      }

      console.log(`✓ Successfully restored file ${fileid} to ${topath}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

program.parse();
