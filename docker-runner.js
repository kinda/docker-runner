'use strict';

var crypto = require('crypto');
var _ = require('lodash');
var co = require('co');
var exec = require('co-exec');
var shellParser = require('node-shell-parser');
var koa = require('koa');
var body = require('koa-body');
var request = require('request');

var WEBHOOK_URL = '/v1/docker-images/push';

var options = require("nomnom")
  .script("docker-runner")
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
    detach: {
      abbr: 'd',
      flag: true,
      required: true, // TODO: should be optional
      help: 'Detached mode: run the container in the background'
    },
    interactive: {
      abbr: 'i',
      flag: true,
      help: 'Keep STDIN open even if not attached'
    },
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
  })
  .parse();

var pullImage = function *() {
  try {
    var previousId = yield getImageId();
    yield exec('docker pull ' + options.image);
    var currentId = yield getImageId();
    return currentId !== previousId;
  } finally {
    console.log('pullImage: done');
  }
};

var runImage = function *() {
  try {
    var cmd = 'docker run';
    if (options.name) cmd += ' --name=' + options.name;
    if (options.net) cmd += ' --net=' + options.net;
    if (options.volume) {
      _.forEach(options.volume, function(volume) {
        cmd += ' --volume=' + volume;
      });
    }
    if (options.detach) cmd += ' --detach';
    if (options.interactive) cmd += ' --interactive';
    if (options.tty) cmd += ' --tty';
    if (options.restart) {
      if (_.contains(options.restart, 'always')) cmd += ' --restart=always';
      // TODO: support more restart policies
    };
    cmd += ' ' + options.image;
    yield exec(cmd);
  } finally {
    console.log('runImage: done');
  }
};

var listenImagePush = function *() {
  var port = determineImagePort();
  var app = koa();
  app.use(body());
  app.use(function *(next) {
    if (this.method === 'POST' && this.url === WEBHOOK_URL) {
      var payload = this.request.body;
      var err;
      var repoName = payload.repository.repo_name;
      var name = getImageName();
      if (repoName !== name) {
        err = new Error('webhook triggered for a different image name ("' + repoName + '" instead of "' + name + '")');
      }
      if (!err) {
        try {
          if (yield pullImage()) {
            yield stopContainer();
            yield removeContainer();
            yield runImage();
          }
        } catch (e) {
          err = e;
        }
      }
      if (err) console.error(err);
      var callbackURL = payload.callback_url;
      var body = { state: (err ? 'error' : 'success') };
      request({
        method: 'post',
        url: callbackURL,
        body: body,
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
    var url = 'http://<domain.name>:' + port + WEBHOOK_URL;
    console.log('listenImagePush: running on ' + url);
  });
};

var getImageName = function() {
  var name = options.image;
  var index = name.indexOf(':');
  if (index !== -1) name = name.substr(0, index);
  return name;
};

var getImageTag = function() {
  var name = options.image;
  var index = name.indexOf(':');
  var tag = index !== -1 ? name.substr(index + 1) : 'latest';
  return tag;
};

var getImageId = function *() {
  var output = yield exec('docker images --no-trunc');
  output = shellParser(output, { separator: '  ' });
  output = _.find(output, {
    REPOSITORY: getImageName(),
    TAG: getImageTag()
  });
  if (!output) return;
  var id = output['IMAGE ID'];
  return id;
};

var determineImagePort = function() {
  var hash = crypto.createHash('md5').update(options.image).digest('hex');
  var port = parseInt('0x' + hash.substr(0, 4));
  port = port % 16384 + 49152;
  return port;
};

var stopContainer = function *() {
  try {
    var id = yield getContainerId(options.name);
    if (!id) return;
    var container = yield inspectContainer(id);
    if (!container.State.Running) return;
    yield exec('docker stop ' + id);
  } finally {
    console.log('stopContainer: done');
  }
};

var removeContainer = function *() {
  try {
    var id = yield getContainerId(options.name);
    if (!id) return;
    yield exec('docker rm ' + id);
  } finally {
    console.log('removeContainer: done');
  }
};

var getContainerId = function *(name) {
  var output = yield exec('docker ps --all --no-trunc');
  output = shellParser(output, { separator: '  ' });
  output = _.find(output, { NAMES: name });
  if (!output) return;
  var id = output['CONTAINER ID'];
  return id;
};

var inspectContainer = function *(id) {
  var output = yield exec('docker inspect ' + id);
  output = JSON.parse(output);
  var container = output[0];
  return container;
};

var main = function *() {
  if (yield pullImage()) {
    yield stopContainer();
    yield removeContainer();
    yield runImage();
  }
  if (_.contains(options.restart, 'image-push')) {
    yield listenImagePush();
  }
};

co(function *() {
  yield main();
}).catch(function(err) {
  console.error(err.stack);
});
