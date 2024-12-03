//
//  Created by Mingliang Chen on 17/8/1.
//  illuspas[a]gmail.com
//  Copyright (c) 2018 Nodemedia. All rights reserved.
//


const Fs = require('fs');
const path = require('path');
const Http = require('http');
const Http2 = require('http2');
const WebSocket = require('ws');
const Express = require('express');
const H2EBridge = require('http2-express-bridge');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth-connect');
const NodeFlvSession = require('./node_flv_session');
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const HTTP_MEDIAROOT = './media';
const Logger = require('./node_core_logger');
const context = require('./node_core_ctx');

const streamsRoute = require('./api/routes/streams');
const serverRoute = require('./api/routes/server');
const relayRoute = require('./api/routes/relay');
const { createS3Client ,uploadFileToS3 } = require('./node_storage_upload');
const dotenv = require('./node_flv_session');
const chokidar = require('chokidar');


class ObjectStorageUploader {
  constructor(mediaroot, bucketName) {
    this.mediaroot = mediaroot;
    this.bucketName = bucketName;

    // chokidar로 .ts 파일 감지
    console.log(this.mediaroot);
    this.watcher = chokidar.watch(`${this.mediaroot}/`, {
      persistent: true,
      ignoreInitial: true, // 초기 파일 스캔 무시
      awaitWriteFinish: {
        stabilityThreshold: 2000, // 파일 작성 완료 대기 시간 (ms)
        pollInterval: 100, // 파일 작성 확인 주기
      },
    });

    this.watcher.on('add', (filePath) => {
      this.handleFileAdd(filePath);
    });
  }

  async handleFileAdd(filePath) {
    try {
      const relativePath = path.relative(this.mediaroot, filePath);
      const destPath = relativePath.replace(/^\/+/, ''); // 경로 조정
      console.log(`Detected new .ts file: ${filePath}`);

      // Object Storage에 업로드
      await uploadFileToS3(this.bucketName, destPath, filePath);
      console.log(`File uploaded to Object Storage: ${destPath}`);

      // 썸네일 업로드
      const thumbnailPath = filePath.split('/').slice(0, -1).join('/') + '/thumbnail.png';
      const thumbnailStoragePath = destPath.split('/').slice(0, -1).join('/') + '/thumbnail.png';
      if (Fs.existsSync(thumbnailPath)) {
        await uploadFileToS3(this.bucketName, thumbnailStoragePath, thumbnailPath);
        console.log(`Thumbnail uploaded to Object Storage: ${thumbnailStoragePath}`);
      }
    } catch (error) {
      Logger.error(`Error uploading file to Object Storage: ${error.message}`);
    }
  }

  close() {
    this.watcher.close();
  }
}

class NodeHttpServer {
  constructor(config) {
    this.port = config.http.port || HTTP_PORT;
    this.mediaroot = config.http.mediaroot || HTTP_MEDIAROOT;
    this.config = config;

    this.objectStorageUploader = new ObjectStorageUploader(this.mediaroot, process.env.OBJECT_STORAGE_BUCKET_NAME);

    let app = H2EBridge(Express);
    app.use(bodyParser.json());

    app.use(bodyParser.urlencoded({ extended: true }));

    app.all('*', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', this.config.http.allow_origin);
      res.header('Access-Control-Allow-Headers', 'Content-Type,Content-Length, Authorization, Accept,X-Requested-With');
      res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Credentials', true);
      req.method === 'OPTIONS' ? res.sendStatus(200) : next();
    });

    app.get('*.flv', (req, res, next) => {
      req.nmsConnectionType = 'http';
      this.onConnect(req, res);
    });

    let adminEntry = path.join(process.cwd(), 'nodeMediaServer/public/admin/index.html');
    if (Fs.existsSync(adminEntry)) {
      app.get('/admin/*', (req, res) => {
        res.sendFile(adminEntry);
      });
    }

    if (this.config.http.api !== false) {
      if (this.config.auth && this.config.auth.api) {
        app.use(['/api/*', '/static/*', '/admin/*'], basicAuth(this.config.auth.api_user, this.config.auth.api_pass));
      }
      app.use('/api/streams', streamsRoute(context));
      app.use('/api/server', serverRoute(context));
      app.use('/api/relay', relayRoute(context));
    }

    app.use(Express.static(path.join(process.cwd(), 'nodeMediaServer/public')));

    // app.use(Express.static(this.mediaroot));
    // 기존 express.static을 커스텀 핸들러로 대체
    app.use((req, res, next) => {
      // Object Storage 업로드 로직
      const uploadFilePath = path.join(this.mediaroot, req.path);

      // Fs.access(uploadFilePath, Fs.constants.F_OK, (err) => {
      //   const destPath = req.path.replace(/^\/+/, ''); // /live/web22 같이 들어왔을 때, live/web22 로 경로 바꿔주기 위해서 replace
      //   const reqPath = destPath.split('/');
      //   const streamKey = reqPath[1];
      //   const sessionKey = context.streamSessions.get(streamKey);
      //   reqPath[1] = sessionKey;
      //   const uploadKey = reqPath.join('/');
      //   console.log('upload path: ', uploadKey);
      //   console.log(destPath, reqPath, streamKey, sessionKey);

      //   const tsRegex = /\.ts$/;
      //   if (err) {
      //     console.log(`File not found: ${uploadFilePath}`);
      //     res.status(302).send('File is not loaded');
      //   } else {
      //     console.log('object storage upload');
      //     uploadFileToS3(process.env.OBJECT_STORAGE_BUCKET_NAME, uploadKey, uploadFilePath).then((r) => {
      //       console.log('upload completed');
      //     });
      //     if (destPath.match(tsRegex)) {
      //       const thumbnailPath = uploadFilePath.split('/').slice(0, -1).join('/');
      //       const thumbnailStoragePath = uploadKey.split('/').slice(0, -1).join('/') + '/thumbnail.png';
      //       uploadFileToS3(process.env.OBJECT_STORAGE_BUCKET_NAME, thumbnailStoragePath, `${thumbnailPath}/thumbnail.png`).then((r) => {
      //         console.log('thumbnail upload completed');
      //       });  
      //     }
      //     console.log(`uploadFilePath : ${uploadFilePath}`);
      //     res.sendFile(uploadFilePath);
      //   }
      // });
    });


    this.httpServer = Http.createServer(app);

    if (this.config.https) {
      let options = {
        key: Fs.readFileSync(this.config.https.key),
        cert: Fs.readFileSync(this.config.https.cert)
      };
      if (this.config.https.passphrase) {
        Object.assign(options, { passphrase: this.config.https.passphrase });
      }
      this.sport = config.https.port ? config.https.port : HTTPS_PORT;
      this.httpsServer = Http2.createSecureServer(options, app);
    }
  }

  run() {
    this.httpServer.listen(this.port, () => {
      Logger.log(`Node Media Http Server started on port: ${this.port}`);
    });

    this.httpServer.on('error', (e) => {
      Logger.error(`Node Media Http Server ${e}`);
    });

    this.httpServer.on('close', () => {
      Logger.log('Node Media Http Server Close.');
    });

    this.wsServer = new WebSocket.Server({ server: this.httpServer });

    this.wsServer.on('connection', (ws, req) => {
      req.nmsConnectionType = 'ws';
      this.onConnect(req, ws);
    });

    this.wsServer.on('listening', () => {
      Logger.log(`Node Media WebSocket Server started on port: ${this.port}`);
    });
    this.wsServer.on('error', (e) => {
      Logger.error(`Node Media WebSocket Server ${e}`);
    });

    if (this.httpsServer) {
      this.httpsServer.listen(this.sport, () => {
        Logger.log(`Node Media Https Server started on port: ${this.sport}`);
      });

      this.httpsServer.on('error', (e) => {
        Logger.error(`Node Media Https Server ${e}`);
      });

      this.httpsServer.on('close', () => {
        Logger.log('Node Media Https Server Close.');
      });

      this.wssServer = new WebSocket.Server({ server: this.httpsServer });

      this.wssServer.on('connection', (ws, req) => {
        req.nmsConnectionType = 'ws';
        this.onConnect(req, ws);
      });

      this.wssServer.on('listening', () => {
        Logger.log(`Node Media WebSocketSecure Server started on port: ${this.sport}`);
      });
      this.wssServer.on('error', (e) => {
        Logger.error(`Node Media WebSocketSecure Server ${e}`);
      });
    }

    context.nodeEvent.on('postPlay', (id, args) => {
      context.stat.accepted++;
    });

    context.nodeEvent.on('postPublish', (id, args) => {
      context.stat.accepted++;
    });

    context.nodeEvent.on('doneConnect', (id, args) => {
      let session = context.sessions.get(id);
      let socket = session instanceof NodeFlvSession ? session.req.socket : session.socket;
      context.stat.inbytes += socket.bytesRead;
      context.stat.outbytes += socket.bytesWritten;
    });
  }

  stop() {
    this.httpServer.close();
    if (this.httpsServer) {
      this.httpsServer.close();
    }
    this.objectStorageUploader.close();
    context.sessions.forEach((session, id) => {
      if (session instanceof NodeFlvSession) {
        session.req.destroy();
        context.sessions.delete(id);
      }
    });
  }

  onConnect(req, res) {
    let session = new NodeFlvSession(this.config, req, res);
    session.run();

  }
}

module.exports = NodeHttpServer;
