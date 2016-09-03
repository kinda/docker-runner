'use strict';

import crypto from 'crypto';
import _ from 'lodash';
import nomnom from 'nomnom';
import Docker from 'dockerode-promise';
import koa from 'koa';
import body from 'koa-body';
import request from 'request';

let WEBHOOK_URL = '/v1/docker-images/push';

let options = nomnom
  .script('docker-runner')
  .options({
    name: {
      required: true, // TODO: should be optional
      help: 'Assign a name to the container'
    },
    net: {
      help: 'Set the Network mode for the container'
    },
    volume: {
      abbr: 'v',
      list: true,
      help: 'Bind mount a volume'
    },
    env: {
      abbr: 'e',
      list: true,
      help: 'Set environment variables'
    },
    detach: {
      abbr: 'd',
      flag: true,
      required: true, // TODO: should be optional
      help: 'Detached mode: run the container in the background'
    },
    // interactive: {
    //   abbr: 'i',
    //   flag: true,
    //   help: 'Keep STDIN open even if not attached'
    // },
    tty: {
      abbr: 't',
      flag: true,
      help: 'Allocate a pseudo-TTY'
    },
    restart: {
      list: true,
      help: 'Restart policy to apply'
    },
    image: {
      position: 0,
      required: true,
      help: 'Image to pull and run'
    },
    authConfig: {
      full: 'auth-config',
      help: 'Registry authConfig value'
    }
  })
  .parse();

let docker = new Docker();

async function pullImage() {
  try {
    let previousId = await getImageId();
    let opts = {};
    if (options.authConfig) opts.authconfig = { key: options.authConfig };
    let stream = await docker.pull(options.image, opts);
    await awaitStream(stream);
    let currentId = await getImageId();
    return currentId !== previousId;
  } finally {
    console.log('pullImage: done');
  }
}

function awaitStream(stream) {
  return new Promise(function(resolve, reject) {
    docker.$subject.modem.followProgress(
      stream,
      function(err, output) { // onFinished
        if (err) {
          reject(err);
          return;
        }
        resolve(output);
      },
      function(event) { // onProgress
        if (event.progressDetail) return;
        if (event.status) console.log(event.status);
      }
    );
  });
}

async function runImage() {
  try {
    let createOptions = { Image: options.image };
    let startOptions = {};
    if (options.name) createOptions.name = options.name;
    if (options.net) startOptions.NetworkMode = options.net;
    if (options.volume) startOptions.Binds = options.volume;
    if (options.env) createOptions.Env = options.env;
    if (!options.detach) throw new Error('non detached mode is unsupported');
    if (options.tty) createOptions.Tty = true;
    if (options.restart) {
      if (options.restart.includes('always')) {
        startOptions.RestartPolicy = { Name: 'always' };
      }
      // TODO: support more restart policies
    }
    let container = await docker.createContainer(createOptions);
    await container.start(startOptions);
  } finally {
    console.log('runImage: done');
  }
}

async function removeOldImages() {
  try {
    let images = await docker.listImages();
    images = images.filter(function(image) {
      return _.isEqual(image.RepoTags, ['<none>:<none>']);
    });
    for (let image of images) {
      try {
        await docker.getImage(image.Id).remove();
        console.log('Image ' + image.Id + ' removed');
      } catch (err) {
        console.error(err);
      }
    }
  } finally {
    console.log('removeOldImages: done');
  }
}

async function listenImagePush() {
  let port = determineImagePort();
  let app = koa();
  app.use(body());
  app.use(function *(next) {
    if (this.method === 'POST' && this.url === WEBHOOK_URL) {
      let payload = this.request.body;
      let err;
      let repoName = payload.repository.repo_name;
      let name = getImageName();
      if (repoName !== name) {
        err = new Error('webhook triggered for a different image name ("' + repoName + '" instead of "' + name + '")');
      }
      if (!err) {
        try {
          yield check();
        } catch (e) {
          err = e;
        }
      }
      if (err) console.error(err);
      let callbackURL = payload.callback_url;
      let body = { state: (err ? 'error' : 'success') };
      request({
        method: 'post',
        url: callbackURL,
        body,
        json: true
      }, function(err) {
        if (err) console.error(err);
      });
      this.status = 204;
      return;
    }
    yield next;
  });
  app.listen(port, function() {
    let url = 'http://<domain.name>:' + port + WEBHOOK_URL;
    console.log('listenImagePush: running on ' + url);
  });
}

function getImageName() {
  let name = options.image;
  let index = name.indexOf(':');
  if (index !== -1) name = name.substr(0, index);
  return name;
}

// function getImageTag() {
//   let name = options.image;
//   let index = name.indexOf(':');
//   let tag = index !== -1 ? name.substr(index + 1) : 'latest';
//   return tag;
// }

async function getImageId() {
  let images = await docker.listImages();
  let image = images.find(function(image) {
    return image.RepoTags.includes(options.image);
  });
  return image && image.Id;
}

function determineImagePort() {
  let hash = crypto.createHash('md5').update(options.image).digest('hex');
  let port = parseInt('0x' + hash.substr(0, 4), 16);
  port = port % 16384 + 49152;
  return port;
}

async function stopContainer() {
  try {
    let id = await getContainerId(options.name);
    if (!id) return;
    let container = docker.getContainer(id);
    let output = await container.inspect();
    if (!output.State.Running) return;
    await container.stop();
  } finally {
    console.log('stopContainer: done');
  }
}

async function removeContainer() {
  try {
    let id = await getContainerId(options.name);
    if (!id) return;
    let container = docker.getContainer(id);
    await container.remove();
  } finally {
    console.log('removeContainer: done');
  }
}

async function getContainerId(name) {
  let containers = await docker.listContainers({ all: true });
  let container = containers.find(function(container) {
    return container.Names.includes('/' + name);
  });
  return container && container.Id;
}

async function check() {
  if (await pullImage()) {
    await stopContainer();
    await removeContainer();
    await runImage();
    await removeOldImages();
  }
}

async function main() {
  await check();
  let id = await getContainerId(options.name);
  if (!id) await runImage();
  if (options.restart && options.restart.includes('image-push')) {
    await listenImagePush();
  }
}

main().catch(function(err) {
  console.error(err);
});
