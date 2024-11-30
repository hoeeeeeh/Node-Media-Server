import chokidar from 'chokidar';
import * as path from 'path';

// 감시할 디렉터리 경로 설정
const directoryPath = './watched_dir';

// chokidar를 사용하여 디렉터리 감시 설정
const watcher = chokidar.watch(directoryPath, {
  persistent: true,
  ignoreInitial: false,
  followSymlinks: true,
  depth: 99,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 100
  }
});

// .m3u8 파일과 .ts 파일의 생성 및 변경 이벤트 처리
watcher
    .on('add', (filePath) => {
      if (filePath.endsWith('.m3u8') || filePath.endsWith('.ts')) {
        console.log(`파일이 새로 생성됨: ${path.basename(filePath)}`);
      }
    })
    .on('change', (filePath) => {
      if (filePath.endsWith('.m3u8') || filePath.endsWith('.ts')) {
        console.log(`파일이 변경됨: ${path.basename(filePath)}`);
      }
    })
    .on('error', (error) => {
      console.error(`감시 중 오류 발생: ${error}`);
    });
