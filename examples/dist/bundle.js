require=(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":2}],2:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.
var BrowserMutationObserver = global.MutationObserver || global.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],3:[function(require,module,exports){
'use strict';

var _interopRequireWildcard = function (obj) { return obj && obj.__esModule ? obj : { 'default': obj }; };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } };

exports.__esModule = true;

var _isDisposable = require('./isDisposable');

var _isDisposable2 = _interopRequireWildcard(_isDisposable);

/**
 * Represents a group of disposable resources that are disposed together.
 */

var CompositeDisposable = (function () {
  function CompositeDisposable() {
    for (var _len = arguments.length, disposables = Array(_len), _key = 0; _key < _len; _key++) {
      disposables[_key] = arguments[_key];
    }

    _classCallCheck(this, CompositeDisposable);

    if (Array.isArray(disposables[0]) && disposables.length === 1) {
      disposables = disposables[0];
    }

    for (var i = 0; i < disposables.length; i++) {
      if (!_isDisposable2['default'](disposables[i])) {
        throw new Error('Expected a disposable');
      }
    }

    this.disposables = disposables;
    this.isDisposed = false;
  }

  /**
   * Adds a disposable to the CompositeDisposable or disposes the disposable if the CompositeDisposable is disposed.
   * @param {Disposable} item Disposable to add.
   */

  CompositeDisposable.prototype.add = function add(item) {
    if (this.isDisposed) {
      item.dispose();
    } else {
      this.disposables.push(item);
    }
  };

  /**
   * Removes and disposes the first occurrence of a disposable from the CompositeDisposable.
   * @param {Disposable} item Disposable to remove.
   * @returns {Boolean} true if found; false otherwise.
   */

  CompositeDisposable.prototype.remove = function remove(item) {
    if (this.isDisposed) {
      return false;
    }

    var index = this.disposables.indexOf(item);
    if (index === -1) {
      return false;
    }

    this.disposables.splice(index, 1);
    item.dispose();
    return true;
  };

  /**
   * Disposes all disposables in the group and removes them from the group.
   */

  CompositeDisposable.prototype.dispose = function dispose() {
    if (this.isDisposed) {
      return;
    }

    var len = this.disposables.length;
    var currentDisposables = new Array(len);
    for (var i = 0; i < len; i++) {
      currentDisposables[i] = this.disposables[i];
    }

    this.isDisposed = true;
    this.disposables = [];
    this.length = 0;

    for (var i = 0; i < len; i++) {
      currentDisposables[i].dispose();
    }
  };

  return CompositeDisposable;
})();

exports['default'] = CompositeDisposable;
module.exports = exports['default'];
},{"./isDisposable":7}],4:[function(require,module,exports){
"use strict";

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

exports.__esModule = true;
var noop = function noop() {};

/**
 * The basic disposable.
 */

var Disposable = (function () {
  function Disposable(action) {
    _classCallCheck(this, Disposable);

    this.isDisposed = false;
    this.action = action || noop;
  }

  Disposable.prototype.dispose = function dispose() {
    if (!this.isDisposed) {
      this.action.call(null);
      this.isDisposed = true;
    }
  };

  _createClass(Disposable, null, [{
    key: "empty",
    enumerable: true,
    value: { dispose: noop }
  }]);

  return Disposable;
})();

exports["default"] = Disposable;
module.exports = exports["default"];
},{}],5:[function(require,module,exports){
'use strict';

var _interopRequireWildcard = function (obj) { return obj && obj.__esModule ? obj : { 'default': obj }; };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } };

exports.__esModule = true;

var _isDisposable = require('./isDisposable');

var _isDisposable2 = _interopRequireWildcard(_isDisposable);

var SerialDisposable = (function () {
  function SerialDisposable() {
    _classCallCheck(this, SerialDisposable);

    this.isDisposed = false;
    this.current = null;
  }

  /**
   * Gets the underlying disposable.
   * @return The underlying disposable.
   */

  SerialDisposable.prototype.getDisposable = function getDisposable() {
    return this.current;
  };

  /**
   * Sets the underlying disposable.
   * @param {Disposable} value The new underlying disposable.
   */

  SerialDisposable.prototype.setDisposable = function setDisposable() {
    var value = arguments[0] === undefined ? null : arguments[0];

    if (value != null && !_isDisposable2['default'](value)) {
      throw new Error('Expected either an empty value or a valid disposable');
    }

    var isDisposed = this.isDisposed;
    var previous = undefined;

    if (!isDisposed) {
      previous = this.current;
      this.current = value;
    }

    if (previous) {
      previous.dispose();
    }

    if (isDisposed && value) {
      value.dispose();
    }
  };

  /**
   * Disposes the underlying disposable as well as all future replacements.
   */

  SerialDisposable.prototype.dispose = function dispose() {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    var previous = this.current;
    this.current = null;

    if (previous) {
      previous.dispose();
    }
  };

  return SerialDisposable;
})();

exports['default'] = SerialDisposable;
module.exports = exports['default'];
},{"./isDisposable":7}],6:[function(require,module,exports){
'use strict';

var _interopRequireWildcard = function (obj) { return obj && obj.__esModule ? obj : { 'default': obj }; };

exports.__esModule = true;

var _isDisposable2 = require('./isDisposable');

var _isDisposable3 = _interopRequireWildcard(_isDisposable2);

exports.isDisposable = _isDisposable3['default'];

var _Disposable2 = require('./Disposable');

var _Disposable3 = _interopRequireWildcard(_Disposable2);

exports.Disposable = _Disposable3['default'];

var _CompositeDisposable2 = require('./CompositeDisposable');

var _CompositeDisposable3 = _interopRequireWildcard(_CompositeDisposable2);

exports.CompositeDisposable = _CompositeDisposable3['default'];

var _SerialDisposable2 = require('./SerialDisposable');

var _SerialDisposable3 = _interopRequireWildcard(_SerialDisposable2);

exports.SerialDisposable = _SerialDisposable3['default'];
},{"./CompositeDisposable":3,"./Disposable":4,"./SerialDisposable":5,"./isDisposable":7}],7:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = isDisposable;

function isDisposable(obj) {
  return Boolean(obj && typeof obj.dispose === 'function');
}

module.exports = exports['default'];
},{}],8:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _reduxLibCreateStore = require('redux/lib/createStore');

var _reduxLibCreateStore2 = _interopRequireDefault(_reduxLibCreateStore);

var _reducers = require('./reducers');

var _reducers2 = _interopRequireDefault(_reducers);

var _actionsDragDrop = require('./actions/dragDrop');

var dragDropActions = _interopRequireWildcard(_actionsDragDrop);

var _DragDropMonitor = require('./DragDropMonitor');

var _DragDropMonitor2 = _interopRequireDefault(_DragDropMonitor);

var _HandlerRegistry = require('./HandlerRegistry');

var _HandlerRegistry2 = _interopRequireDefault(_HandlerRegistry);

var DragDropManager = (function () {
  function DragDropManager(createBackend) {
    _classCallCheck(this, DragDropManager);

    var store = _reduxLibCreateStore2['default'](_reducers2['default']);

    this.store = store;
    this.monitor = new _DragDropMonitor2['default'](store);
    this.registry = this.monitor.registry;
    this.backend = createBackend(this);

    store.subscribe(this.handleRefCountChange.bind(this));
  }

  DragDropManager.prototype.handleRefCountChange = function handleRefCountChange() {
    var shouldSetUp = this.store.getState().refCount > 0;
    if (shouldSetUp && !this.isSetUp) {
      this.backend.setup();
      this.isSetUp = true;
    } else if (!shouldSetUp && this.isSetUp) {
      this.backend.teardown();
      this.isSetUp = false;
    }
  };

  DragDropManager.prototype.getMonitor = function getMonitor() {
    return this.monitor;
  };

  DragDropManager.prototype.getBackend = function getBackend() {
    return this.backend;
  };

  DragDropManager.prototype.getRegistry = function getRegistry() {
    return this.registry;
  };

  DragDropManager.prototype.getActions = function getActions() {
    var manager = this;
    var dispatch = this.store.dispatch;

    function bindActionCreator(actionCreator) {
      return function () {
        var action = actionCreator.apply(manager, arguments);
        if (typeof action !== 'undefined') {
          dispatch(action);
        }
      };
    }

    return Object.keys(dragDropActions).filter(function (key) {
      return typeof dragDropActions[key] === 'function';
    }).reduce(function (boundActions, key) {
      boundActions[key] = bindActionCreator(dragDropActions[key]);
      return boundActions;
    }, {});
  };

  return DragDropManager;
})();

exports['default'] = DragDropManager;
module.exports = exports['default'];
},{"./DragDropMonitor":9,"./HandlerRegistry":12,"./actions/dragDrop":13,"./reducers":20,"redux/lib/createStore":204}],9:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _utilsMatchesType = require('./utils/matchesType');

var _utilsMatchesType2 = _interopRequireDefault(_utilsMatchesType);

var _lodashIsArray = require('lodash/isArray');

var _lodashIsArray2 = _interopRequireDefault(_lodashIsArray);

var _HandlerRegistry = require('./HandlerRegistry');

var _HandlerRegistry2 = _interopRequireDefault(_HandlerRegistry);

var _reducersDragOffset = require('./reducers/dragOffset');

var _reducersDirtyHandlerIds = require('./reducers/dirtyHandlerIds');

var DragDropMonitor = (function () {
  function DragDropMonitor(store) {
    _classCallCheck(this, DragDropMonitor);

    this.store = store;
    this.registry = new _HandlerRegistry2['default'](store);
  }

  DragDropMonitor.prototype.subscribeToStateChange = function subscribeToStateChange(listener) {
    var _this = this;

    var _ref = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

    var handlerIds = _ref.handlerIds;

    _invariant2['default'](typeof listener === 'function', 'listener must be a function.');
    _invariant2['default'](typeof handlerIds === 'undefined' || _lodashIsArray2['default'](handlerIds), 'handlerIds, when specified, must be an array of strings.');

    var prevStateId = this.store.getState().stateId;
    var handleChange = function handleChange() {
      var state = _this.store.getState();
      var currentStateId = state.stateId;
      try {
        var canSkipListener = currentStateId === prevStateId || currentStateId === prevStateId + 1 && !_reducersDirtyHandlerIds.areDirty(state.dirtyHandlerIds, handlerIds);

        if (!canSkipListener) {
          listener();
        }
      } finally {
        prevStateId = currentStateId;
      }
    };

    return this.store.subscribe(handleChange);
  };

  DragDropMonitor.prototype.subscribeToOffsetChange = function subscribeToOffsetChange(listener) {
    var _this2 = this;

    _invariant2['default'](typeof listener === 'function', 'listener must be a function.');

    var previousState = this.store.getState().dragOffset;
    var handleChange = function handleChange() {
      var nextState = _this2.store.getState().dragOffset;
      if (nextState === previousState) {
        return;
      }

      previousState = nextState;
      listener();
    };

    return this.store.subscribe(handleChange);
  };

  DragDropMonitor.prototype.canDragSource = function canDragSource(sourceId) {
    var source = this.registry.getSource(sourceId);
    _invariant2['default'](source, 'Expected to find a valid source.');

    if (this.isDragging()) {
      return false;
    }

    return source.canDrag(this, sourceId);
  };

  DragDropMonitor.prototype.canDropOnTarget = function canDropOnTarget(targetId) {
    var target = this.registry.getTarget(targetId);
    _invariant2['default'](target, 'Expected to find a valid target.');

    if (!this.isDragging() || this.didDrop()) {
      return false;
    }

    var targetType = this.registry.getTargetType(targetId);
    var draggedItemType = this.getItemType();
    return _utilsMatchesType2['default'](targetType, draggedItemType) && target.canDrop(this, targetId);
  };

  DragDropMonitor.prototype.isDragging = function isDragging() {
    return Boolean(this.getItemType());
  };

  DragDropMonitor.prototype.isDraggingSource = function isDraggingSource(sourceId) {
    var source = this.registry.getSource(sourceId, true);
    _invariant2['default'](source, 'Expected to find a valid source.');

    if (!this.isDragging() || !this.isSourcePublic()) {
      return false;
    }

    var sourceType = this.registry.getSourceType(sourceId);
    var draggedItemType = this.getItemType();
    if (sourceType !== draggedItemType) {
      return false;
    }

    return source.isDragging(this, sourceId);
  };

  DragDropMonitor.prototype.isOverTarget = function isOverTarget(targetId) {
    var _ref2 = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

    var _ref2$shallow = _ref2.shallow;
    var shallow = _ref2$shallow === undefined ? false : _ref2$shallow;

    if (!this.isDragging()) {
      return false;
    }

    var targetType = this.registry.getTargetType(targetId);
    var draggedItemType = this.getItemType();
    if (!_utilsMatchesType2['default'](targetType, draggedItemType)) {
      return false;
    }

    var targetIds = this.getTargetIds();
    if (!targetIds.length) {
      return false;
    }

    var index = targetIds.indexOf(targetId);
    if (shallow) {
      return index === targetIds.length - 1;
    } else {
      return index > -1;
    }
  };

  DragDropMonitor.prototype.getItemType = function getItemType() {
    return this.store.getState().dragOperation.itemType;
  };

  DragDropMonitor.prototype.getItem = function getItem() {
    return this.store.getState().dragOperation.item;
  };

  DragDropMonitor.prototype.getSourceId = function getSourceId() {
    return this.store.getState().dragOperation.sourceId;
  };

  DragDropMonitor.prototype.getTargetIds = function getTargetIds() {
    return this.store.getState().dragOperation.targetIds;
  };

  DragDropMonitor.prototype.getDropResult = function getDropResult() {
    return this.store.getState().dragOperation.dropResult;
  };

  DragDropMonitor.prototype.didDrop = function didDrop() {
    return this.store.getState().dragOperation.didDrop;
  };

  DragDropMonitor.prototype.isSourcePublic = function isSourcePublic() {
    return this.store.getState().dragOperation.isSourcePublic;
  };

  DragDropMonitor.prototype.getInitialClientOffset = function getInitialClientOffset() {
    return this.store.getState().dragOffset.initialClientOffset;
  };

  DragDropMonitor.prototype.getInitialSourceClientOffset = function getInitialSourceClientOffset() {
    return this.store.getState().dragOffset.initialSourceClientOffset;
  };

  DragDropMonitor.prototype.getClientOffset = function getClientOffset() {
    return this.store.getState().dragOffset.clientOffset;
  };

  DragDropMonitor.prototype.getSourceClientOffset = function getSourceClientOffset() {
    return _reducersDragOffset.getSourceClientOffset(this.store.getState().dragOffset);
  };

  DragDropMonitor.prototype.getDifferenceFromInitialOffset = function getDifferenceFromInitialOffset() {
    return _reducersDragOffset.getDifferenceFromInitialOffset(this.store.getState().dragOffset);
  };

  return DragDropMonitor;
})();

exports['default'] = DragDropMonitor;
module.exports = exports['default'];
},{"./HandlerRegistry":12,"./reducers/dirtyHandlerIds":17,"./reducers/dragOffset":18,"./utils/matchesType":24,"invariant":88,"lodash/isArray":73}],10:[function(require,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var DragSource = (function () {
  function DragSource() {
    _classCallCheck(this, DragSource);
  }

  DragSource.prototype.canDrag = function canDrag() {
    return true;
  };

  DragSource.prototype.isDragging = function isDragging(monitor, handle) {
    return handle === monitor.getSourceId();
  };

  DragSource.prototype.endDrag = function endDrag() {};

  return DragSource;
})();

exports["default"] = DragSource;
module.exports = exports["default"];
},{}],11:[function(require,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var DropTarget = (function () {
  function DropTarget() {
    _classCallCheck(this, DropTarget);
  }

  DropTarget.prototype.canDrop = function canDrop() {
    return true;
  };

  DropTarget.prototype.hover = function hover() {};

  DropTarget.prototype.drop = function drop() {};

  return DropTarget;
})();

exports["default"] = DropTarget;
module.exports = exports["default"];
},{}],12:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _typeof(obj) { return obj && obj.constructor === Symbol ? 'symbol' : typeof obj; }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsArray = require('lodash/isArray');

var _lodashIsArray2 = _interopRequireDefault(_lodashIsArray);

var _utilsGetNextUniqueId = require('./utils/getNextUniqueId');

var _utilsGetNextUniqueId2 = _interopRequireDefault(_utilsGetNextUniqueId);

var _actionsRegistry = require('./actions/registry');

var _asap = require('asap');

var _asap2 = _interopRequireDefault(_asap);

var HandlerRoles = {
  SOURCE: 'SOURCE',
  TARGET: 'TARGET'
};

function validateSourceContract(source) {
  _invariant2['default'](typeof source.canDrag === 'function', 'Expected canDrag to be a function.');
  _invariant2['default'](typeof source.beginDrag === 'function', 'Expected beginDrag to be a function.');
  _invariant2['default'](typeof source.endDrag === 'function', 'Expected endDrag to be a function.');
}

function validateTargetContract(target) {
  _invariant2['default'](typeof target.canDrop === 'function', 'Expected canDrop to be a function.');
  _invariant2['default'](typeof target.hover === 'function', 'Expected hover to be a function.');
  _invariant2['default'](typeof target.drop === 'function', 'Expected beginDrag to be a function.');
}

function validateType(type, allowArray) {
  if (allowArray && _lodashIsArray2['default'](type)) {
    type.forEach(function (t) {
      return validateType(t, false);
    });
    return;
  }

  _invariant2['default'](typeof type === 'string' || (typeof type === 'undefined' ? 'undefined' : _typeof(type)) === 'symbol', allowArray ? 'Type can only be a string, a symbol, or an array of either.' : 'Type can only be a string or a symbol.');
}

function getNextHandlerId(role) {
  var id = _utilsGetNextUniqueId2['default']().toString();
  switch (role) {
    case HandlerRoles.SOURCE:
      return 'S' + id;
    case HandlerRoles.TARGET:
      return 'T' + id;
    default:
      _invariant2['default'](false, 'Unknown role: ' + role);
  }
}

function parseRoleFromHandlerId(handlerId) {
  switch (handlerId[0]) {
    case 'S':
      return HandlerRoles.SOURCE;
    case 'T':
      return HandlerRoles.TARGET;
    default:
      _invariant2['default'](false, 'Cannot parse handler ID: ' + handlerId);
  }
}

var HandlerRegistry = (function () {
  function HandlerRegistry(store) {
    _classCallCheck(this, HandlerRegistry);

    this.store = store;

    this.types = {};
    this.handlers = {};

    this.pinnedSourceId = null;
    this.pinnedSource = null;
  }

  HandlerRegistry.prototype.addSource = function addSource(type, source) {
    validateType(type);
    validateSourceContract(source);

    var sourceId = this.addHandler(HandlerRoles.SOURCE, type, source);
    this.store.dispatch(_actionsRegistry.addSource(sourceId));
    return sourceId;
  };

  HandlerRegistry.prototype.addTarget = function addTarget(type, target) {
    validateType(type, true);
    validateTargetContract(target);

    var targetId = this.addHandler(HandlerRoles.TARGET, type, target);
    this.store.dispatch(_actionsRegistry.addTarget(targetId));
    return targetId;
  };

  HandlerRegistry.prototype.addHandler = function addHandler(role, type, handler) {
    var id = getNextHandlerId(role);
    this.types[id] = type;
    this.handlers[id] = handler;

    return id;
  };

  HandlerRegistry.prototype.containsHandler = function containsHandler(handler) {
    var _this = this;

    return Object.keys(this.handlers).some(function (key) {
      return _this.handlers[key] === handler;
    });
  };

  HandlerRegistry.prototype.getSource = function getSource(sourceId, includePinned) {
    _invariant2['default'](this.isSourceId(sourceId), 'Expected a valid source ID.');

    var isPinned = includePinned && sourceId === this.pinnedSourceId;
    var source = isPinned ? this.pinnedSource : this.handlers[sourceId];

    return source;
  };

  HandlerRegistry.prototype.getTarget = function getTarget(targetId) {
    _invariant2['default'](this.isTargetId(targetId), 'Expected a valid target ID.');
    return this.handlers[targetId];
  };

  HandlerRegistry.prototype.getSourceType = function getSourceType(sourceId) {
    _invariant2['default'](this.isSourceId(sourceId), 'Expected a valid source ID.');
    return this.types[sourceId];
  };

  HandlerRegistry.prototype.getTargetType = function getTargetType(targetId) {
    _invariant2['default'](this.isTargetId(targetId), 'Expected a valid target ID.');
    return this.types[targetId];
  };

  HandlerRegistry.prototype.isSourceId = function isSourceId(handlerId) {
    var role = parseRoleFromHandlerId(handlerId);
    return role === HandlerRoles.SOURCE;
  };

  HandlerRegistry.prototype.isTargetId = function isTargetId(handlerId) {
    var role = parseRoleFromHandlerId(handlerId);
    return role === HandlerRoles.TARGET;
  };

  HandlerRegistry.prototype.removeSource = function removeSource(sourceId) {
    var _this2 = this;

    _invariant2['default'](this.getSource(sourceId), 'Expected an existing source.');
    this.store.dispatch(_actionsRegistry.removeSource(sourceId));

    _asap2['default'](function () {
      delete _this2.handlers[sourceId];
      delete _this2.types[sourceId];
    });
  };

  HandlerRegistry.prototype.removeTarget = function removeTarget(targetId) {
    var _this3 = this;

    _invariant2['default'](this.getTarget(targetId), 'Expected an existing target.');
    this.store.dispatch(_actionsRegistry.removeTarget(targetId));

    _asap2['default'](function () {
      delete _this3.handlers[targetId];
      delete _this3.types[targetId];
    });
  };

  HandlerRegistry.prototype.pinSource = function pinSource(sourceId) {
    var source = this.getSource(sourceId);
    _invariant2['default'](source, 'Expected an existing source.');

    this.pinnedSourceId = sourceId;
    this.pinnedSource = source;
  };

  HandlerRegistry.prototype.unpinSource = function unpinSource() {
    _invariant2['default'](this.pinnedSource, 'No source is pinned at the time.');

    this.pinnedSourceId = null;
    this.pinnedSource = null;
  };

  return HandlerRegistry;
})();

exports['default'] = HandlerRegistry;
module.exports = exports['default'];
},{"./actions/registry":14,"./utils/getNextUniqueId":23,"asap":1,"invariant":88,"lodash/isArray":73}],13:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports.beginDrag = beginDrag;
exports.publishDragSource = publishDragSource;
exports.hover = hover;
exports.drop = drop;
exports.endDrag = endDrag;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _utilsMatchesType = require('../utils/matchesType');

var _utilsMatchesType2 = _interopRequireDefault(_utilsMatchesType);

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsArray = require('lodash/isArray');

var _lodashIsArray2 = _interopRequireDefault(_lodashIsArray);

var _lodashIsObject = require('lodash/isObject');

var _lodashIsObject2 = _interopRequireDefault(_lodashIsObject);

var BEGIN_DRAG = 'dnd-core/BEGIN_DRAG';
exports.BEGIN_DRAG = BEGIN_DRAG;
var PUBLISH_DRAG_SOURCE = 'dnd-core/PUBLISH_DRAG_SOURCE';
exports.PUBLISH_DRAG_SOURCE = PUBLISH_DRAG_SOURCE;
var HOVER = 'dnd-core/HOVER';
exports.HOVER = HOVER;
var DROP = 'dnd-core/DROP';
exports.DROP = DROP;
var END_DRAG = 'dnd-core/END_DRAG';

exports.END_DRAG = END_DRAG;

function beginDrag(sourceIds) {
  var _ref = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  var _ref$publishSource = _ref.publishSource;
  var publishSource = _ref$publishSource === undefined ? true : _ref$publishSource;
  var _ref$clientOffset = _ref.clientOffset;
  var clientOffset = _ref$clientOffset === undefined ? null : _ref$clientOffset;
  var getSourceClientOffset = _ref.getSourceClientOffset;

  _invariant2['default'](_lodashIsArray2['default'](sourceIds), 'Expected sourceIds to be an array.');

  var monitor = this.getMonitor();
  var registry = this.getRegistry();
  _invariant2['default'](!monitor.isDragging(), 'Cannot call beginDrag while dragging.');

  for (var i = 0; i < sourceIds.length; i++) {
    _invariant2['default'](registry.getSource(sourceIds[i]), 'Expected sourceIds to be registered.');
  }

  var sourceId = null;
  for (var i = sourceIds.length - 1; i >= 0; i--) {
    if (monitor.canDragSource(sourceIds[i])) {
      sourceId = sourceIds[i];
      break;
    }
  }
  if (sourceId === null) {
    return;
  }

  var sourceClientOffset = null;
  if (clientOffset) {
    _invariant2['default'](typeof getSourceClientOffset === 'function', 'When clientOffset is provided, getSourceClientOffset must be a function.');
    sourceClientOffset = getSourceClientOffset(sourceId);
  }

  var source = registry.getSource(sourceId);
  var item = source.beginDrag(monitor, sourceId);
  _invariant2['default'](_lodashIsObject2['default'](item), 'Item must be an object.');

  registry.pinSource(sourceId);

  var itemType = registry.getSourceType(sourceId);
  return {
    type: BEGIN_DRAG,
    itemType: itemType,
    item: item,
    sourceId: sourceId,
    clientOffset: clientOffset,
    sourceClientOffset: sourceClientOffset,
    isSourcePublic: publishSource
  };
}

function publishDragSource(manager) {
  var monitor = this.getMonitor();
  if (!monitor.isDragging()) {
    return;
  }

  return {
    type: PUBLISH_DRAG_SOURCE
  };
}

function hover(targetIds) {
  var _ref2 = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  var _ref2$clientOffset = _ref2.clientOffset;
  var clientOffset = _ref2$clientOffset === undefined ? null : _ref2$clientOffset;

  _invariant2['default'](_lodashIsArray2['default'](targetIds), 'Expected targetIds to be an array.');
  targetIds = targetIds.slice(0);

  var monitor = this.getMonitor();
  var registry = this.getRegistry();
  _invariant2['default'](monitor.isDragging(), 'Cannot call hover while not dragging.');
  _invariant2['default'](!monitor.didDrop(), 'Cannot call hover after drop.');

  // First check invariants.
  for (var i = 0; i < targetIds.length; i++) {
    var targetId = targetIds[i];
    _invariant2['default'](targetIds.lastIndexOf(targetId) === i, 'Expected targetIds to be unique in the passed array.');

    var target = registry.getTarget(targetId);
    _invariant2['default'](target, 'Expected targetIds to be registered.');
  }

  var draggedItemType = monitor.getItemType();

  // Remove those targetIds that don't match the targetType.  This
  // fixes shallow isOver which would only be non-shallow because of
  // non-matching targets.
  for (var i = targetIds.length - 1; i >= 0; i--) {
    var targetId = targetIds[i];
    var targetType = registry.getTargetType(targetId);
    if (!_utilsMatchesType2['default'](targetType, draggedItemType)) {
      targetIds.splice(i, 1);
    }
  }

  // Finally call hover on all matching targets.
  for (var i = 0; i < targetIds.length; i++) {
    var targetId = targetIds[i];
    var target = registry.getTarget(targetId);
    target.hover(monitor, targetId);
  }

  return {
    type: HOVER,
    targetIds: targetIds,
    clientOffset: clientOffset
  };
}

function drop() {
  var _this = this;

  var monitor = this.getMonitor();
  var registry = this.getRegistry();
  _invariant2['default'](monitor.isDragging(), 'Cannot call drop while not dragging.');
  _invariant2['default'](!monitor.didDrop(), 'Cannot call drop twice during one drag operation.');

  var targetIds = monitor.getTargetIds().filter(monitor.canDropOnTarget, monitor);

  targetIds.reverse();
  targetIds.forEach(function (targetId, index) {
    var target = registry.getTarget(targetId);

    var dropResult = target.drop(monitor, targetId);
    _invariant2['default'](typeof dropResult === 'undefined' || _lodashIsObject2['default'](dropResult), 'Drop result must either be an object or undefined.');
    if (typeof dropResult === 'undefined') {
      dropResult = index === 0 ? {} : monitor.getDropResult();
    }

    _this.store.dispatch({
      type: DROP,
      dropResult: dropResult
    });
  });
}

function endDrag() {
  var monitor = this.getMonitor();
  var registry = this.getRegistry();
  _invariant2['default'](monitor.isDragging(), 'Cannot call endDrag while not dragging.');

  var sourceId = monitor.getSourceId();
  var source = registry.getSource(sourceId, true);
  source.endDrag(monitor, sourceId);

  registry.unpinSource();

  return {
    type: END_DRAG
  };
}
},{"../utils/matchesType":24,"invariant":88,"lodash/isArray":73,"lodash/isObject":79}],14:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports.addSource = addSource;
exports.addTarget = addTarget;
exports.removeSource = removeSource;
exports.removeTarget = removeTarget;
var ADD_SOURCE = 'dnd-core/ADD_SOURCE';
exports.ADD_SOURCE = ADD_SOURCE;
var ADD_TARGET = 'dnd-core/ADD_TARGET';
exports.ADD_TARGET = ADD_TARGET;
var REMOVE_SOURCE = 'dnd-core/REMOVE_SOURCE';
exports.REMOVE_SOURCE = REMOVE_SOURCE;
var REMOVE_TARGET = 'dnd-core/REMOVE_TARGET';

exports.REMOVE_TARGET = REMOVE_TARGET;

function addSource(sourceId) {
  return {
    type: ADD_SOURCE,
    sourceId: sourceId
  };
}

function addTarget(targetId) {
  return {
    type: ADD_TARGET,
    targetId: targetId
  };
}

function removeSource(sourceId) {
  return {
    type: REMOVE_SOURCE,
    sourceId: sourceId
  };
}

function removeTarget(targetId) {
  return {
    type: REMOVE_TARGET,
    targetId: targetId
  };
}
},{}],15:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createBackend;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _lodashNoop = require('lodash/noop');

var _lodashNoop2 = _interopRequireDefault(_lodashNoop);

var TestBackend = (function () {
  function TestBackend(manager) {
    _classCallCheck(this, TestBackend);

    this.actions = manager.getActions();
  }

  TestBackend.prototype.setup = function setup() {
    this.didCallSetup = true;
  };

  TestBackend.prototype.teardown = function teardown() {
    this.didCallTeardown = true;
  };

  TestBackend.prototype.connectDragSource = function connectDragSource() {
    return _lodashNoop2['default'];
  };

  TestBackend.prototype.connectDragPreview = function connectDragPreview() {
    return _lodashNoop2['default'];
  };

  TestBackend.prototype.connectDropTarget = function connectDropTarget() {
    return _lodashNoop2['default'];
  };

  TestBackend.prototype.simulateBeginDrag = function simulateBeginDrag(sourceIds, options) {
    this.actions.beginDrag(sourceIds, options);
  };

  TestBackend.prototype.simulatePublishDragSource = function simulatePublishDragSource() {
    this.actions.publishDragSource();
  };

  TestBackend.prototype.simulateHover = function simulateHover(targetIds, options) {
    this.actions.hover(targetIds, options);
  };

  TestBackend.prototype.simulateDrop = function simulateDrop() {
    this.actions.drop();
  };

  TestBackend.prototype.simulateEndDrag = function simulateEndDrag() {
    this.actions.endDrag();
  };

  return TestBackend;
})();

function createBackend(manager) {
  return new TestBackend(manager);
}

module.exports = exports['default'];
},{"lodash/noop":82}],16:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequire(obj) { return obj && obj.__esModule ? obj['default'] : obj; }

var _DragDropManager = require('./DragDropManager');

exports.DragDropManager = _interopRequire(_DragDropManager);

var _DragSource = require('./DragSource');

exports.DragSource = _interopRequire(_DragSource);

var _DropTarget = require('./DropTarget');

exports.DropTarget = _interopRequire(_DropTarget);

var _backendsCreateTestBackend = require('./backends/createTestBackend');

exports.createTestBackend = _interopRequire(_backendsCreateTestBackend);
},{"./DragDropManager":8,"./DragSource":10,"./DropTarget":11,"./backends/createTestBackend":15}],17:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = dirtyHandlerIds;
exports.areDirty = areDirty;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _lodashXor = require('lodash/xor');

var _lodashXor2 = _interopRequireDefault(_lodashXor);

var _lodashIntersection = require('lodash/intersection');

var _lodashIntersection2 = _interopRequireDefault(_lodashIntersection);

var _actionsDragDrop = require('../actions/dragDrop');

var _actionsRegistry = require('../actions/registry');

var NONE = [];
var ALL = [];

function dirtyHandlerIds(state, action, dragOperation) {
  if (state === undefined) state = NONE;

  switch (action.type) {
    case _actionsDragDrop.HOVER:
      break;
    case _actionsRegistry.ADD_SOURCE:
    case _actionsRegistry.ADD_TARGET:
    case _actionsRegistry.REMOVE_TARGET:
    case _actionsRegistry.REMOVE_SOURCE:
      return NONE;
    case _actionsDragDrop.BEGIN_DRAG:
    case _actionsDragDrop.PUBLISH_DRAG_SOURCE:
    case _actionsDragDrop.END_DRAG:
    case _actionsDragDrop.DROP:
    default:
      return ALL;
  }

  var targetIds = action.targetIds;
  var prevTargetIds = dragOperation.targetIds;

  var dirtyHandlerIds = _lodashXor2['default'](targetIds, prevTargetIds);

  var didChange = false;
  if (dirtyHandlerIds.length === 0) {
    for (var i = 0; i < targetIds.length; i++) {
      if (targetIds[i] !== prevTargetIds[i]) {
        didChange = true;
        break;
      }
    }
  } else {
    didChange = true;
  }

  if (!didChange) {
    return NONE;
  }

  var prevInnermostTargetId = prevTargetIds[prevTargetIds.length - 1];
  var innermostTargetId = targetIds[targetIds.length - 1];

  if (prevInnermostTargetId !== innermostTargetId) {
    if (prevInnermostTargetId) {
      dirtyHandlerIds.push(prevInnermostTargetId);
    }
    if (innermostTargetId) {
      dirtyHandlerIds.push(innermostTargetId);
    }
  }

  return dirtyHandlerIds;
}

function areDirty(state, handlerIds) {
  if (state === NONE) {
    return false;
  }

  if (state === ALL || typeof handlerIds === 'undefined') {
    return true;
  }

  return _lodashIntersection2['default'](handlerIds, state).length > 0;
}
},{"../actions/dragDrop":13,"../actions/registry":14,"lodash/intersection":72,"lodash/xor":87}],18:[function(require,module,exports){
'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

exports['default'] = dragOffset;
exports.getSourceClientOffset = getSourceClientOffset;
exports.getDifferenceFromInitialOffset = getDifferenceFromInitialOffset;

var _actionsDragDrop = require('../actions/dragDrop');

var initialState = {
  initialSourceClientOffset: null,
  initialClientOffset: null,
  clientOffset: null
};

function areOffsetsEqual(offsetA, offsetB) {
  if (offsetA === offsetB) {
    return true;
  }
  return offsetA && offsetB && offsetA.x === offsetB.x && offsetA.y === offsetB.y;
}

function dragOffset(state, action) {
  if (state === undefined) state = initialState;

  switch (action.type) {
    case _actionsDragDrop.BEGIN_DRAG:
      return {
        initialSourceClientOffset: action.sourceClientOffset,
        initialClientOffset: action.clientOffset,
        clientOffset: action.clientOffset
      };
    case _actionsDragDrop.HOVER:
      if (areOffsetsEqual(state.clientOffset, action.clientOffset)) {
        return state;
      }
      return _extends({}, state, {
        clientOffset: action.clientOffset
      });
    case _actionsDragDrop.END_DRAG:
    case _actionsDragDrop.DROP:
      return initialState;
    default:
      return state;
  }
}

function getSourceClientOffset(state) {
  var clientOffset = state.clientOffset;
  var initialClientOffset = state.initialClientOffset;
  var initialSourceClientOffset = state.initialSourceClientOffset;

  if (!clientOffset || !initialClientOffset || !initialSourceClientOffset) {
    return null;
  }
  return {
    x: clientOffset.x + initialSourceClientOffset.x - initialClientOffset.x,
    y: clientOffset.y + initialSourceClientOffset.y - initialClientOffset.y
  };
}

function getDifferenceFromInitialOffset(state) {
  var clientOffset = state.clientOffset;
  var initialClientOffset = state.initialClientOffset;

  if (!clientOffset || !initialClientOffset) {
    return null;
  }
  return {
    x: clientOffset.x - initialClientOffset.x,
    y: clientOffset.y - initialClientOffset.y
  };
}
},{"../actions/dragDrop":13}],19:[function(require,module,exports){
'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

exports['default'] = dragOperation;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _actionsDragDrop = require('../actions/dragDrop');

var _actionsRegistry = require('../actions/registry');

var _lodashWithout = require('lodash/without');

var _lodashWithout2 = _interopRequireDefault(_lodashWithout);

var initialState = {
  itemType: null,
  item: null,
  sourceId: null,
  targetIds: [],
  dropResult: null,
  didDrop: false,
  isSourcePublic: null
};

function dragOperation(state, action) {
  if (state === undefined) state = initialState;

  switch (action.type) {
    case _actionsDragDrop.BEGIN_DRAG:
      return _extends({}, state, {
        itemType: action.itemType,
        item: action.item,
        sourceId: action.sourceId,
        isSourcePublic: action.isSourcePublic,
        dropResult: null,
        didDrop: false
      });
    case _actionsDragDrop.PUBLISH_DRAG_SOURCE:
      return _extends({}, state, {
        isSourcePublic: true
      });
    case _actionsDragDrop.HOVER:
      return _extends({}, state, {
        targetIds: action.targetIds
      });
    case _actionsRegistry.REMOVE_TARGET:
      if (state.targetIds.indexOf(action.targetId) === -1) {
        return state;
      }
      return _extends({}, state, {
        targetIds: _lodashWithout2['default'](state.targetIds, action.targetId)
      });
    case _actionsDragDrop.DROP:
      return _extends({}, state, {
        dropResult: action.dropResult,
        didDrop: true,
        targetIds: []
      });
    case _actionsDragDrop.END_DRAG:
      return _extends({}, state, {
        itemType: null,
        item: null,
        sourceId: null,
        dropResult: null,
        didDrop: false,
        isSourcePublic: null,
        targetIds: []
      });
    default:
      return state;
  }
}

module.exports = exports['default'];
},{"../actions/dragDrop":13,"../actions/registry":14,"lodash/without":86}],20:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _dragOffset = require('./dragOffset');

var _dragOffset2 = _interopRequireDefault(_dragOffset);

var _dragOperation = require('./dragOperation');

var _dragOperation2 = _interopRequireDefault(_dragOperation);

var _refCount = require('./refCount');

var _refCount2 = _interopRequireDefault(_refCount);

var _dirtyHandlerIds = require('./dirtyHandlerIds');

var _dirtyHandlerIds2 = _interopRequireDefault(_dirtyHandlerIds);

var _stateId = require('./stateId');

var _stateId2 = _interopRequireDefault(_stateId);

exports['default'] = function (state, action) {
  if (state === undefined) state = {};

  return {
    dirtyHandlerIds: _dirtyHandlerIds2['default'](state.dirtyHandlerIds, action, state.dragOperation),
    dragOffset: _dragOffset2['default'](state.dragOffset, action),
    refCount: _refCount2['default'](state.refCount, action),
    dragOperation: _dragOperation2['default'](state.dragOperation, action),
    stateId: _stateId2['default'](state.stateId)
  };
};

module.exports = exports['default'];
},{"./dirtyHandlerIds":17,"./dragOffset":18,"./dragOperation":19,"./refCount":21,"./stateId":22}],21:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = refCount;

var _actionsRegistry = require('../actions/registry');

function refCount(state, action) {
  if (state === undefined) state = 0;

  switch (action.type) {
    case _actionsRegistry.ADD_SOURCE:
    case _actionsRegistry.ADD_TARGET:
      return state + 1;
    case _actionsRegistry.REMOVE_SOURCE:
    case _actionsRegistry.REMOVE_TARGET:
      return state - 1;
    default:
      return state;
  }
}

module.exports = exports['default'];
},{"../actions/registry":14}],22:[function(require,module,exports){
"use strict";

exports.__esModule = true;
exports["default"] = stateId;

function stateId() {
  var state = arguments.length <= 0 || arguments[0] === undefined ? 0 : arguments[0];

  return state + 1;
}

module.exports = exports["default"];
},{}],23:[function(require,module,exports){
"use strict";

exports.__esModule = true;
exports["default"] = getNextUniqueId;
var nextUniqueId = 0;

function getNextUniqueId() {
  return nextUniqueId++;
}

module.exports = exports["default"];
},{}],24:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = matchesType;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _lodashIsArray = require('lodash/isArray');

var _lodashIsArray2 = _interopRequireDefault(_lodashIsArray);

function matchesType(targetType, draggedItemType) {
  if (_lodashIsArray2['default'](targetType)) {
    return targetType.some(function (t) {
      return t === draggedItemType;
    });
  } else {
    return targetType === draggedItemType;
  }
}

module.exports = exports['default'];
},{"lodash/isArray":73}],25:[function(require,module,exports){
var nativeCreate = require('./_nativeCreate');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Creates a hash object.
 *
 * @private
 * @constructor
 * @returns {Object} Returns the new hash object.
 */
function Hash() {}

// Avoid inheriting from `Object.prototype` when possible.
Hash.prototype = nativeCreate ? nativeCreate(null) : objectProto;

module.exports = Hash;

},{"./_nativeCreate":67}],26:[function(require,module,exports){
var getNative = require('./_getNative'),
    root = require('./_root');

/* Built-in method references that are verified to be native. */
var Map = getNative(root, 'Map');

module.exports = Map;

},{"./_getNative":54,"./_root":68}],27:[function(require,module,exports){
var mapClear = require('./_mapClear'),
    mapDelete = require('./_mapDelete'),
    mapGet = require('./_mapGet'),
    mapHas = require('./_mapHas'),
    mapSet = require('./_mapSet');

/**
 * Creates a map cache object to store key-value pairs.
 *
 * @private
 * @constructor
 * @param {Array} [values] The values to cache.
 */
function MapCache(values) {
  var index = -1,
      length = values ? values.length : 0;

  this.clear();
  while (++index < length) {
    var entry = values[index];
    this.set(entry[0], entry[1]);
  }
}

// Add methods to `MapCache`.
MapCache.prototype.clear = mapClear;
MapCache.prototype['delete'] = mapDelete;
MapCache.prototype.get = mapGet;
MapCache.prototype.has = mapHas;
MapCache.prototype.set = mapSet;

module.exports = MapCache;

},{"./_mapClear":62,"./_mapDelete":63,"./_mapGet":64,"./_mapHas":65,"./_mapSet":66}],28:[function(require,module,exports){
var getNative = require('./_getNative'),
    root = require('./_root');

/* Built-in method references that are verified to be native. */
var Set = getNative(root, 'Set');

module.exports = Set;

},{"./_getNative":54,"./_root":68}],29:[function(require,module,exports){
var MapCache = require('./_MapCache'),
    cachePush = require('./_cachePush');

/**
 *
 * Creates a set cache object to store unique values.
 *
 * @private
 * @constructor
 * @param {Array} [values] The values to cache.
 */
function SetCache(values) {
  var index = -1,
      length = values ? values.length : 0;

  this.__data__ = new MapCache;
  while (++index < length) {
    this.push(values[index]);
  }
}

// Add methods to `SetCache`.
SetCache.prototype.push = cachePush;

module.exports = SetCache;

},{"./_MapCache":27,"./_cachePush":49}],30:[function(require,module,exports){
/**
 * A faster alternative to `Function#apply`, this function invokes `func`
 * with the `this` binding of `thisArg` and the arguments of `args`.
 *
 * @private
 * @param {Function} func The function to invoke.
 * @param {*} thisArg The `this` binding of `func`.
 * @param {Array} args The arguments to invoke `func` with.
 * @returns {*} Returns the result of `func`.
 */
function apply(func, thisArg, args) {
  var length = args.length;
  switch (length) {
    case 0: return func.call(thisArg);
    case 1: return func.call(thisArg, args[0]);
    case 2: return func.call(thisArg, args[0], args[1]);
    case 3: return func.call(thisArg, args[0], args[1], args[2]);
  }
  return func.apply(thisArg, args);
}

module.exports = apply;

},{}],31:[function(require,module,exports){
/**
 * A specialized version of `_.filter` for arrays without support for
 * iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to iterate over.
 * @param {Function} predicate The function invoked per iteration.
 * @returns {Array} Returns the new filtered array.
 */
function arrayFilter(array, predicate) {
  var index = -1,
      length = array.length,
      resIndex = 0,
      result = [];

  while (++index < length) {
    var value = array[index];
    if (predicate(value, index, array)) {
      result[resIndex++] = value;
    }
  }
  return result;
}

module.exports = arrayFilter;

},{}],32:[function(require,module,exports){
var baseIndexOf = require('./_baseIndexOf');

/**
 * A specialized version of `_.includes` for arrays without support for
 * specifying an index to search from.
 *
 * @private
 * @param {Array} array The array to search.
 * @param {*} target The value to search for.
 * @returns {boolean} Returns `true` if `target` is found, else `false`.
 */
function arrayIncludes(array, value) {
  return !!array.length && baseIndexOf(array, value, 0) > -1;
}

module.exports = arrayIncludes;

},{"./_baseIndexOf":42}],33:[function(require,module,exports){
/**
 * This function is like `arrayIncludes` except that it accepts a comparator.
 *
 * @private
 * @param {Array} array The array to search.
 * @param {*} target The value to search for.
 * @param {Function} comparator The comparator invoked per element.
 * @returns {boolean} Returns `true` if `target` is found, else `false`.
 */
function arrayIncludesWith(array, value, comparator) {
  var index = -1,
      length = array.length;

  while (++index < length) {
    if (comparator(value, array[index])) {
      return true;
    }
  }
  return false;
}

module.exports = arrayIncludesWith;

},{}],34:[function(require,module,exports){
/**
 * A specialized version of `_.map` for arrays without support for iteratee
 * shorthands.
 *
 * @private
 * @param {Array} array The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns the new mapped array.
 */
function arrayMap(array, iteratee) {
  var index = -1,
      length = array.length,
      result = Array(length);

  while (++index < length) {
    result[index] = iteratee(array[index], index, array);
  }
  return result;
}

module.exports = arrayMap;

},{}],35:[function(require,module,exports){
/**
 * Appends the elements of `values` to `array`.
 *
 * @private
 * @param {Array} array The array to modify.
 * @param {Array} values The values to append.
 * @returns {Array} Returns `array`.
 */
function arrayPush(array, values) {
  var index = -1,
      length = values.length,
      offset = array.length;

  while (++index < length) {
    array[offset + index] = values[index];
  }
  return array;
}

module.exports = arrayPush;

},{}],36:[function(require,module,exports){
var assocIndexOf = require('./_assocIndexOf');

/** Used for built-in method references. */
var arrayProto = Array.prototype;

/** Built-in value references. */
var splice = arrayProto.splice;

/**
 * Removes `key` and its value from the associative array.
 *
 * @private
 * @param {Array} array The array to modify.
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function assocDelete(array, key) {
  var index = assocIndexOf(array, key);
  if (index < 0) {
    return false;
  }
  var lastIndex = array.length - 1;
  if (index == lastIndex) {
    array.pop();
  } else {
    splice.call(array, index, 1);
  }
  return true;
}

module.exports = assocDelete;

},{"./_assocIndexOf":39}],37:[function(require,module,exports){
var assocIndexOf = require('./_assocIndexOf');

/**
 * Gets the associative array value for `key`.
 *
 * @private
 * @param {Array} array The array to query.
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function assocGet(array, key) {
  var index = assocIndexOf(array, key);
  return index < 0 ? undefined : array[index][1];
}

module.exports = assocGet;

},{"./_assocIndexOf":39}],38:[function(require,module,exports){
var assocIndexOf = require('./_assocIndexOf');

/**
 * Checks if an associative array value for `key` exists.
 *
 * @private
 * @param {Array} array The array to query.
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function assocHas(array, key) {
  return assocIndexOf(array, key) > -1;
}

module.exports = assocHas;

},{"./_assocIndexOf":39}],39:[function(require,module,exports){
var eq = require('./eq');

/**
 * Gets the index at which the `key` is found in `array` of key-value pairs.
 *
 * @private
 * @param {Array} array The array to search.
 * @param {*} key The key to search for.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function assocIndexOf(array, key) {
  var length = array.length;
  while (length--) {
    if (eq(array[length][0], key)) {
      return length;
    }
  }
  return -1;
}

module.exports = assocIndexOf;

},{"./eq":71}],40:[function(require,module,exports){
var assocIndexOf = require('./_assocIndexOf');

/**
 * Sets the associative array `key` to `value`.
 *
 * @private
 * @param {Array} array The array to modify.
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 */
function assocSet(array, key, value) {
  var index = assocIndexOf(array, key);
  if (index < 0) {
    array.push([key, value]);
  } else {
    array[index][1] = value;
  }
}

module.exports = assocSet;

},{"./_assocIndexOf":39}],41:[function(require,module,exports){
var SetCache = require('./_SetCache'),
    arrayIncludes = require('./_arrayIncludes'),
    arrayIncludesWith = require('./_arrayIncludesWith'),
    arrayMap = require('./_arrayMap'),
    baseUnary = require('./_baseUnary'),
    cacheHas = require('./_cacheHas');

/** Used as the size to enable large array optimizations. */
var LARGE_ARRAY_SIZE = 200;

/**
 * The base implementation of methods like `_.difference` without support
 * for excluding multiple arrays or iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {Array} values The values to exclude.
 * @param {Function} [iteratee] The iteratee invoked per element.
 * @param {Function} [comparator] The comparator invoked per element.
 * @returns {Array} Returns the new array of filtered values.
 */
function baseDifference(array, values, iteratee, comparator) {
  var index = -1,
      includes = arrayIncludes,
      isCommon = true,
      length = array.length,
      result = [],
      valuesLength = values.length;

  if (!length) {
    return result;
  }
  if (iteratee) {
    values = arrayMap(values, baseUnary(iteratee));
  }
  if (comparator) {
    includes = arrayIncludesWith;
    isCommon = false;
  }
  else if (values.length >= LARGE_ARRAY_SIZE) {
    includes = cacheHas;
    isCommon = false;
    values = new SetCache(values);
  }
  outer:
  while (++index < length) {
    var value = array[index],
        computed = iteratee ? iteratee(value) : value;

    if (isCommon && computed === computed) {
      var valuesIndex = valuesLength;
      while (valuesIndex--) {
        if (values[valuesIndex] === computed) {
          continue outer;
        }
      }
      result.push(value);
    }
    else if (!includes(values, computed, comparator)) {
      result.push(value);
    }
  }
  return result;
}

module.exports = baseDifference;

},{"./_SetCache":29,"./_arrayIncludes":32,"./_arrayIncludesWith":33,"./_arrayMap":34,"./_baseUnary":45,"./_cacheHas":48}],42:[function(require,module,exports){
var indexOfNaN = require('./_indexOfNaN');

/**
 * The base implementation of `_.indexOf` without `fromIndex` bounds checks.
 *
 * @private
 * @param {Array} array The array to search.
 * @param {*} value The value to search for.
 * @param {number} fromIndex The index to search from.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function baseIndexOf(array, value, fromIndex) {
  if (value !== value) {
    return indexOfNaN(array, fromIndex);
  }
  var index = fromIndex - 1,
      length = array.length;

  while (++index < length) {
    if (array[index] === value) {
      return index;
    }
  }
  return -1;
}

module.exports = baseIndexOf;

},{"./_indexOfNaN":59}],43:[function(require,module,exports){
var SetCache = require('./_SetCache'),
    arrayIncludes = require('./_arrayIncludes'),
    arrayIncludesWith = require('./_arrayIncludesWith'),
    arrayMap = require('./_arrayMap'),
    baseUnary = require('./_baseUnary'),
    cacheHas = require('./_cacheHas');

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeMin = Math.min;

/**
 * The base implementation of methods like `_.intersection`, without support
 * for iteratee shorthands, that accepts an array of arrays to inspect.
 *
 * @private
 * @param {Array} arrays The arrays to inspect.
 * @param {Function} [iteratee] The iteratee invoked per element.
 * @param {Function} [comparator] The comparator invoked per element.
 * @returns {Array} Returns the new array of shared values.
 */
function baseIntersection(arrays, iteratee, comparator) {
  var includes = comparator ? arrayIncludesWith : arrayIncludes,
      length = arrays[0].length,
      othLength = arrays.length,
      othIndex = othLength,
      caches = Array(othLength),
      maxLength = Infinity,
      result = [];

  while (othIndex--) {
    var array = arrays[othIndex];
    if (othIndex && iteratee) {
      array = arrayMap(array, baseUnary(iteratee));
    }
    maxLength = nativeMin(array.length, maxLength);
    caches[othIndex] = !comparator && (iteratee || (length >= 120 && array.length >= 120))
      ? new SetCache(othIndex && array)
      : undefined;
  }
  array = arrays[0];

  var index = -1,
      seen = caches[0];

  outer:
  while (++index < length && result.length < maxLength) {
    var value = array[index],
        computed = iteratee ? iteratee(value) : value;

    if (!(seen
          ? cacheHas(seen, computed)
          : includes(result, computed, comparator)
        )) {
      othIndex = othLength;
      while (--othIndex) {
        var cache = caches[othIndex];
        if (!(cache
              ? cacheHas(cache, computed)
              : includes(arrays[othIndex], computed, comparator))
            ) {
          continue outer;
        }
      }
      if (seen) {
        seen.push(computed);
      }
      result.push(value);
    }
  }
  return result;
}

module.exports = baseIntersection;

},{"./_SetCache":29,"./_arrayIncludes":32,"./_arrayIncludesWith":33,"./_arrayMap":34,"./_baseUnary":45,"./_cacheHas":48}],44:[function(require,module,exports){
/**
 * The base implementation of `_.property` without support for deep paths.
 *
 * @private
 * @param {string} key The key of the property to get.
 * @returns {Function} Returns the new function.
 */
function baseProperty(key) {
  return function(object) {
    return object == null ? undefined : object[key];
  };
}

module.exports = baseProperty;

},{}],45:[function(require,module,exports){
/**
 * The base implementation of `_.unary` without support for storing wrapper metadata.
 *
 * @private
 * @param {Function} func The function to cap arguments for.
 * @returns {Function} Returns the new function.
 */
function baseUnary(func) {
  return function(value) {
    return func(value);
  };
}

module.exports = baseUnary;

},{}],46:[function(require,module,exports){
var SetCache = require('./_SetCache'),
    arrayIncludes = require('./_arrayIncludes'),
    arrayIncludesWith = require('./_arrayIncludesWith'),
    cacheHas = require('./_cacheHas'),
    createSet = require('./_createSet'),
    setToArray = require('./_setToArray');

/** Used as the size to enable large array optimizations. */
var LARGE_ARRAY_SIZE = 200;

/**
 * The base implementation of `_.uniqBy` without support for iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {Function} [iteratee] The iteratee invoked per element.
 * @param {Function} [comparator] The comparator invoked per element.
 * @returns {Array} Returns the new duplicate free array.
 */
function baseUniq(array, iteratee, comparator) {
  var index = -1,
      includes = arrayIncludes,
      length = array.length,
      isCommon = true,
      result = [],
      seen = result;

  if (comparator) {
    isCommon = false;
    includes = arrayIncludesWith;
  }
  else if (length >= LARGE_ARRAY_SIZE) {
    var set = iteratee ? null : createSet(array);
    if (set) {
      return setToArray(set);
    }
    isCommon = false;
    includes = cacheHas;
    seen = new SetCache;
  }
  else {
    seen = iteratee ? [] : result;
  }
  outer:
  while (++index < length) {
    var value = array[index],
        computed = iteratee ? iteratee(value) : value;

    if (isCommon && computed === computed) {
      var seenIndex = seen.length;
      while (seenIndex--) {
        if (seen[seenIndex] === computed) {
          continue outer;
        }
      }
      if (iteratee) {
        seen.push(computed);
      }
      result.push(value);
    }
    else if (!includes(seen, computed, comparator)) {
      if (seen !== result) {
        seen.push(computed);
      }
      result.push(value);
    }
  }
  return result;
}

module.exports = baseUniq;

},{"./_SetCache":29,"./_arrayIncludes":32,"./_arrayIncludesWith":33,"./_cacheHas":48,"./_createSet":52,"./_setToArray":69}],47:[function(require,module,exports){
var arrayPush = require('./_arrayPush'),
    baseDifference = require('./_baseDifference'),
    baseUniq = require('./_baseUniq');

/**
 * The base implementation of methods like `_.xor`, without support for
 * iteratee shorthands, that accepts an array of arrays to inspect.
 *
 * @private
 * @param {Array} arrays The arrays to inspect.
 * @param {Function} [iteratee] The iteratee invoked per element.
 * @param {Function} [comparator] The comparator invoked per element.
 * @returns {Array} Returns the new array of values.
 */
function baseXor(arrays, iteratee, comparator) {
  var index = -1,
      length = arrays.length;

  while (++index < length) {
    var result = result
      ? arrayPush(
          baseDifference(result, arrays[index], iteratee, comparator),
          baseDifference(arrays[index], result, iteratee, comparator)
        )
      : arrays[index];
  }
  return (result && result.length) ? baseUniq(result, iteratee, comparator) : [];
}

module.exports = baseXor;

},{"./_arrayPush":35,"./_baseDifference":41,"./_baseUniq":46}],48:[function(require,module,exports){
var isKeyable = require('./_isKeyable');

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/**
 * Checks if `value` is in `cache`.
 *
 * @private
 * @param {Object} cache The set cache to search.
 * @param {*} value The value to search for.
 * @returns {number} Returns `true` if `value` is found, else `false`.
 */
function cacheHas(cache, value) {
  var map = cache.__data__;
  if (isKeyable(value)) {
    var data = map.__data__,
        hash = typeof value == 'string' ? data.string : data.hash;

    return hash[value] === HASH_UNDEFINED;
  }
  return map.has(value);
}

module.exports = cacheHas;

},{"./_isKeyable":61}],49:[function(require,module,exports){
var isKeyable = require('./_isKeyable');

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/**
 * Adds `value` to the set cache.
 *
 * @private
 * @name push
 * @memberOf SetCache
 * @param {*} value The value to cache.
 */
function cachePush(value) {
  var map = this.__data__;
  if (isKeyable(value)) {
    var data = map.__data__,
        hash = typeof value == 'string' ? data.string : data.hash;

    hash[value] = HASH_UNDEFINED;
  }
  else {
    map.set(value, HASH_UNDEFINED);
  }
}

module.exports = cachePush;

},{"./_isKeyable":61}],50:[function(require,module,exports){
var isArrayLikeObject = require('./isArrayLikeObject');

/**
 * Casts `value` to an empty array if it's not an array like object.
 *
 * @private
 * @param {*} value The value to inspect.
 * @returns {Array|Object} Returns the cast array-like object.
 */
function castArrayLikeObject(value) {
  return isArrayLikeObject(value) ? value : [];
}

module.exports = castArrayLikeObject;

},{"./isArrayLikeObject":75}],51:[function(require,module,exports){
/**
 * Checks if `value` is a global object.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {null|Object} Returns `value` if it's a global object, else `null`.
 */
function checkGlobal(value) {
  return (value && value.Object === Object) ? value : null;
}

module.exports = checkGlobal;

},{}],52:[function(require,module,exports){
var Set = require('./_Set'),
    noop = require('./noop');

/**
 * Creates a set of `values`.
 *
 * @private
 * @param {Array} values The values to add to the set.
 * @returns {Object} Returns the new set.
 */
var createSet = !(Set && new Set([1, 2]).size === 2) ? noop : function(values) {
  return new Set(values);
};

module.exports = createSet;

},{"./_Set":28,"./noop":82}],53:[function(require,module,exports){
var baseProperty = require('./_baseProperty');

/**
 * Gets the "length" property value of `object`.
 *
 * **Note:** This function is used to avoid a
 * [JIT bug](https://bugs.webkit.org/show_bug.cgi?id=142792) that affects
 * Safari on at least iOS 8.1-8.3 ARM64.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {*} Returns the "length" value.
 */
var getLength = baseProperty('length');

module.exports = getLength;

},{"./_baseProperty":44}],54:[function(require,module,exports){
var isNative = require('./isNative');

/**
 * Gets the native function at `key` of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {string} key The key of the method to get.
 * @returns {*} Returns the function if it's native, else `undefined`.
 */
function getNative(object, key) {
  var value = object[key];
  return isNative(value) ? value : undefined;
}

module.exports = getNative;

},{"./isNative":78}],55:[function(require,module,exports){
var hashHas = require('./_hashHas');

/**
 * Removes `key` and its value from the hash.
 *
 * @private
 * @param {Object} hash The hash to modify.
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function hashDelete(hash, key) {
  return hashHas(hash, key) && delete hash[key];
}

module.exports = hashDelete;

},{"./_hashHas":57}],56:[function(require,module,exports){
var nativeCreate = require('./_nativeCreate');

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Gets the hash value for `key`.
 *
 * @private
 * @param {Object} hash The hash to query.
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function hashGet(hash, key) {
  if (nativeCreate) {
    var result = hash[key];
    return result === HASH_UNDEFINED ? undefined : result;
  }
  return hasOwnProperty.call(hash, key) ? hash[key] : undefined;
}

module.exports = hashGet;

},{"./_nativeCreate":67}],57:[function(require,module,exports){
var nativeCreate = require('./_nativeCreate');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Checks if a hash value for `key` exists.
 *
 * @private
 * @param {Object} hash The hash to query.
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function hashHas(hash, key) {
  return nativeCreate ? hash[key] !== undefined : hasOwnProperty.call(hash, key);
}

module.exports = hashHas;

},{"./_nativeCreate":67}],58:[function(require,module,exports){
var nativeCreate = require('./_nativeCreate');

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/**
 * Sets the hash `key` to `value`.
 *
 * @private
 * @param {Object} hash The hash to modify.
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 */
function hashSet(hash, key, value) {
  hash[key] = (nativeCreate && value === undefined) ? HASH_UNDEFINED : value;
}

module.exports = hashSet;

},{"./_nativeCreate":67}],59:[function(require,module,exports){
/**
 * Gets the index at which the first occurrence of `NaN` is found in `array`.
 *
 * @private
 * @param {Array} array The array to search.
 * @param {number} fromIndex The index to search from.
 * @param {boolean} [fromRight] Specify iterating from right to left.
 * @returns {number} Returns the index of the matched `NaN`, else `-1`.
 */
function indexOfNaN(array, fromIndex, fromRight) {
  var length = array.length,
      index = fromIndex + (fromRight ? 0 : -1);

  while ((fromRight ? index-- : ++index < length)) {
    var other = array[index];
    if (other !== other) {
      return index;
    }
  }
  return -1;
}

module.exports = indexOfNaN;

},{}],60:[function(require,module,exports){
/**
 * Checks if `value` is a host object in IE < 9.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a host object, else `false`.
 */
function isHostObject(value) {
  // Many host objects are `Object` objects that can coerce to strings
  // despite having improperly defined `toString` methods.
  var result = false;
  if (value != null && typeof value.toString != 'function') {
    try {
      result = !!(value + '');
    } catch (e) {}
  }
  return result;
}

module.exports = isHostObject;

},{}],61:[function(require,module,exports){
/**
 * Checks if `value` is suitable for use as unique object key.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is suitable, else `false`.
 */
function isKeyable(value) {
  var type = typeof value;
  return type == 'number' || type == 'boolean' ||
    (type == 'string' && value != '__proto__') || value == null;
}

module.exports = isKeyable;

},{}],62:[function(require,module,exports){
var Hash = require('./_Hash'),
    Map = require('./_Map');

/**
 * Removes all key-value entries from the map.
 *
 * @private
 * @name clear
 * @memberOf MapCache
 */
function mapClear() {
  this.__data__ = {
    'hash': new Hash,
    'map': Map ? new Map : [],
    'string': new Hash
  };
}

module.exports = mapClear;

},{"./_Hash":25,"./_Map":26}],63:[function(require,module,exports){
var Map = require('./_Map'),
    assocDelete = require('./_assocDelete'),
    hashDelete = require('./_hashDelete'),
    isKeyable = require('./_isKeyable');

/**
 * Removes `key` and its value from the map.
 *
 * @private
 * @name delete
 * @memberOf MapCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function mapDelete(key) {
  var data = this.__data__;
  if (isKeyable(key)) {
    return hashDelete(typeof key == 'string' ? data.string : data.hash, key);
  }
  return Map ? data.map['delete'](key) : assocDelete(data.map, key);
}

module.exports = mapDelete;

},{"./_Map":26,"./_assocDelete":36,"./_hashDelete":55,"./_isKeyable":61}],64:[function(require,module,exports){
var Map = require('./_Map'),
    assocGet = require('./_assocGet'),
    hashGet = require('./_hashGet'),
    isKeyable = require('./_isKeyable');

/**
 * Gets the map value for `key`.
 *
 * @private
 * @name get
 * @memberOf MapCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function mapGet(key) {
  var data = this.__data__;
  if (isKeyable(key)) {
    return hashGet(typeof key == 'string' ? data.string : data.hash, key);
  }
  return Map ? data.map.get(key) : assocGet(data.map, key);
}

module.exports = mapGet;

},{"./_Map":26,"./_assocGet":37,"./_hashGet":56,"./_isKeyable":61}],65:[function(require,module,exports){
var Map = require('./_Map'),
    assocHas = require('./_assocHas'),
    hashHas = require('./_hashHas'),
    isKeyable = require('./_isKeyable');

/**
 * Checks if a map value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf MapCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function mapHas(key) {
  var data = this.__data__;
  if (isKeyable(key)) {
    return hashHas(typeof key == 'string' ? data.string : data.hash, key);
  }
  return Map ? data.map.has(key) : assocHas(data.map, key);
}

module.exports = mapHas;

},{"./_Map":26,"./_assocHas":38,"./_hashHas":57,"./_isKeyable":61}],66:[function(require,module,exports){
var Map = require('./_Map'),
    assocSet = require('./_assocSet'),
    hashSet = require('./_hashSet'),
    isKeyable = require('./_isKeyable');

/**
 * Sets the map `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf MapCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the map cache instance.
 */
function mapSet(key, value) {
  var data = this.__data__;
  if (isKeyable(key)) {
    hashSet(typeof key == 'string' ? data.string : data.hash, key, value);
  } else if (Map) {
    data.map.set(key, value);
  } else {
    assocSet(data.map, key, value);
  }
  return this;
}

module.exports = mapSet;

},{"./_Map":26,"./_assocSet":40,"./_hashSet":58,"./_isKeyable":61}],67:[function(require,module,exports){
var getNative = require('./_getNative');

/* Built-in method references that are verified to be native. */
var nativeCreate = getNative(Object, 'create');

module.exports = nativeCreate;

},{"./_getNative":54}],68:[function(require,module,exports){
(function (global){
var checkGlobal = require('./_checkGlobal');

/** Used to determine if values are of the language type `Object`. */
var objectTypes = {
  'function': true,
  'object': true
};

/** Detect free variable `exports`. */
var freeExports = (objectTypes[typeof exports] && exports && !exports.nodeType)
  ? exports
  : undefined;

/** Detect free variable `module`. */
var freeModule = (objectTypes[typeof module] && module && !module.nodeType)
  ? module
  : undefined;

/** Detect free variable `global` from Node.js. */
var freeGlobal = checkGlobal(freeExports && freeModule && typeof global == 'object' && global);

/** Detect free variable `self`. */
var freeSelf = checkGlobal(objectTypes[typeof self] && self);

/** Detect free variable `window`. */
var freeWindow = checkGlobal(objectTypes[typeof window] && window);

/** Detect `this` as the global object. */
var thisGlobal = checkGlobal(objectTypes[typeof this] && this);

/**
 * Used as a reference to the global object.
 *
 * The `this` value is used if it's the global object to avoid Greasemonkey's
 * restricted `window` object, otherwise the `window` object is used.
 */
var root = freeGlobal ||
  ((freeWindow !== (thisGlobal && thisGlobal.window)) && freeWindow) ||
    freeSelf || thisGlobal || Function('return this')();

module.exports = root;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./_checkGlobal":51}],69:[function(require,module,exports){
/**
 * Converts `set` to an array.
 *
 * @private
 * @param {Object} set The set to convert.
 * @returns {Array} Returns the converted array.
 */
function setToArray(set) {
  var index = -1,
      result = Array(set.size);

  set.forEach(function(value) {
    result[++index] = value;
  });
  return result;
}

module.exports = setToArray;

},{}],70:[function(require,module,exports){
/** Used to resolve the decompiled source of functions. */
var funcToString = Function.prototype.toString;

/**
 * Converts `func` to its source code.
 *
 * @private
 * @param {Function} func The function to process.
 * @returns {string} Returns the source code.
 */
function toSource(func) {
  if (func != null) {
    try {
      return funcToString.call(func);
    } catch (e) {}
    try {
      return (func + '');
    } catch (e) {}
  }
  return '';
}

module.exports = toSource;

},{}],71:[function(require,module,exports){
/**
 * Performs a
 * [`SameValueZero`](http://ecma-international.org/ecma-262/6.0/#sec-samevaluezero)
 * comparison between two values to determine if they are equivalent.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to compare.
 * @param {*} other The other value to compare.
 * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
 * @example
 *
 * var object = { 'user': 'fred' };
 * var other = { 'user': 'fred' };
 *
 * _.eq(object, object);
 * // => true
 *
 * _.eq(object, other);
 * // => false
 *
 * _.eq('a', 'a');
 * // => true
 *
 * _.eq('a', Object('a'));
 * // => false
 *
 * _.eq(NaN, NaN);
 * // => true
 */
function eq(value, other) {
  return value === other || (value !== value && other !== other);
}

module.exports = eq;

},{}],72:[function(require,module,exports){
var arrayMap = require('./_arrayMap'),
    baseIntersection = require('./_baseIntersection'),
    castArrayLikeObject = require('./_castArrayLikeObject'),
    rest = require('./rest');

/**
 * Creates an array of unique values that are included in all given arrays
 * using [`SameValueZero`](http://ecma-international.org/ecma-262/6.0/#sec-samevaluezero)
 * for equality comparisons. The order of result values is determined by the
 * order they occur in the first array.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Array
 * @param {...Array} [arrays] The arrays to inspect.
 * @returns {Array} Returns the new array of intersecting values.
 * @example
 *
 * _.intersection([2, 1], [4, 2], [1, 2]);
 * // => [2]
 */
var intersection = rest(function(arrays) {
  var mapped = arrayMap(arrays, castArrayLikeObject);
  return (mapped.length && mapped[0] === arrays[0])
    ? baseIntersection(mapped)
    : [];
});

module.exports = intersection;

},{"./_arrayMap":34,"./_baseIntersection":43,"./_castArrayLikeObject":50,"./rest":83}],73:[function(require,module,exports){
/**
 * Checks if `value` is classified as an `Array` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @type {Function}
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is correctly classified,
 *  else `false`.
 * @example
 *
 * _.isArray([1, 2, 3]);
 * // => true
 *
 * _.isArray(document.body.children);
 * // => false
 *
 * _.isArray('abc');
 * // => false
 *
 * _.isArray(_.noop);
 * // => false
 */
var isArray = Array.isArray;

module.exports = isArray;

},{}],74:[function(require,module,exports){
var getLength = require('./_getLength'),
    isFunction = require('./isFunction'),
    isLength = require('./isLength');

/**
 * Checks if `value` is array-like. A value is considered array-like if it's
 * not a function and has a `value.length` that's an integer greater than or
 * equal to `0` and less than or equal to `Number.MAX_SAFE_INTEGER`.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is array-like, else `false`.
 * @example
 *
 * _.isArrayLike([1, 2, 3]);
 * // => true
 *
 * _.isArrayLike(document.body.children);
 * // => true
 *
 * _.isArrayLike('abc');
 * // => true
 *
 * _.isArrayLike(_.noop);
 * // => false
 */
function isArrayLike(value) {
  return value != null && isLength(getLength(value)) && !isFunction(value);
}

module.exports = isArrayLike;

},{"./_getLength":53,"./isFunction":76,"./isLength":77}],75:[function(require,module,exports){
var isArrayLike = require('./isArrayLike'),
    isObjectLike = require('./isObjectLike');

/**
 * This method is like `_.isArrayLike` except that it also checks if `value`
 * is an object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an array-like object,
 *  else `false`.
 * @example
 *
 * _.isArrayLikeObject([1, 2, 3]);
 * // => true
 *
 * _.isArrayLikeObject(document.body.children);
 * // => true
 *
 * _.isArrayLikeObject('abc');
 * // => false
 *
 * _.isArrayLikeObject(_.noop);
 * // => false
 */
function isArrayLikeObject(value) {
  return isObjectLike(value) && isArrayLike(value);
}

module.exports = isArrayLikeObject;

},{"./isArrayLike":74,"./isObjectLike":80}],76:[function(require,module,exports){
var isObject = require('./isObject');

/** `Object#toString` result references. */
var funcTag = '[object Function]',
    genTag = '[object GeneratorFunction]';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/**
 * Checks if `value` is classified as a `Function` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is correctly classified,
 *  else `false`.
 * @example
 *
 * _.isFunction(_);
 * // => true
 *
 * _.isFunction(/abc/);
 * // => false
 */
function isFunction(value) {
  // The use of `Object#toString` avoids issues with the `typeof` operator
  // in Safari 8 which returns 'object' for typed array and weak map constructors,
  // and PhantomJS 1.9 which returns 'function' for `NodeList` instances.
  var tag = isObject(value) ? objectToString.call(value) : '';
  return tag == funcTag || tag == genTag;
}

module.exports = isFunction;

},{"./isObject":79}],77:[function(require,module,exports){
/** Used as references for various `Number` constants. */
var MAX_SAFE_INTEGER = 9007199254740991;

/**
 * Checks if `value` is a valid array-like length.
 *
 * **Note:** This function is loosely based on
 * [`ToLength`](http://ecma-international.org/ecma-262/6.0/#sec-tolength).
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a valid length,
 *  else `false`.
 * @example
 *
 * _.isLength(3);
 * // => true
 *
 * _.isLength(Number.MIN_VALUE);
 * // => false
 *
 * _.isLength(Infinity);
 * // => false
 *
 * _.isLength('3');
 * // => false
 */
function isLength(value) {
  return typeof value == 'number' &&
    value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
}

module.exports = isLength;

},{}],78:[function(require,module,exports){
var isFunction = require('./isFunction'),
    isHostObject = require('./_isHostObject'),
    isObject = require('./isObject'),
    toSource = require('./_toSource');

/**
 * Used to match `RegExp`
 * [syntax characters](http://ecma-international.org/ecma-262/6.0/#sec-patterns).
 */
var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;

/** Used to detect host constructors (Safari). */
var reIsHostCtor = /^\[object .+?Constructor\]$/;

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to resolve the decompiled source of functions. */
var funcToString = Function.prototype.toString;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/** Used to detect if a method is native. */
var reIsNative = RegExp('^' +
  funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$'
);

/**
 * Checks if `value` is a native function.
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a native function,
 *  else `false`.
 * @example
 *
 * _.isNative(Array.prototype.push);
 * // => true
 *
 * _.isNative(_);
 * // => false
 */
function isNative(value) {
  if (!isObject(value)) {
    return false;
  }
  var pattern = (isFunction(value) || isHostObject(value)) ? reIsNative : reIsHostCtor;
  return pattern.test(toSource(value));
}

module.exports = isNative;

},{"./_isHostObject":60,"./_toSource":70,"./isFunction":76,"./isObject":79}],79:[function(require,module,exports){
/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/6.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return !!value && (type == 'object' || type == 'function');
}

module.exports = isObject;

},{}],80:[function(require,module,exports){
/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return !!value && typeof value == 'object';
}

module.exports = isObjectLike;

},{}],81:[function(require,module,exports){
var isObjectLike = require('./isObjectLike');

/** `Object#toString` result references. */
var symbolTag = '[object Symbol]';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/**
 * Checks if `value` is classified as a `Symbol` primitive or object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is correctly classified,
 *  else `false`.
 * @example
 *
 * _.isSymbol(Symbol.iterator);
 * // => true
 *
 * _.isSymbol('abc');
 * // => false
 */
function isSymbol(value) {
  return typeof value == 'symbol' ||
    (isObjectLike(value) && objectToString.call(value) == symbolTag);
}

module.exports = isSymbol;

},{"./isObjectLike":80}],82:[function(require,module,exports){
/**
 * A no-operation function that returns `undefined` regardless of the
 * arguments it receives.
 *
 * @static
 * @memberOf _
 * @since 2.3.0
 * @category Util
 * @example
 *
 * var object = { 'user': 'fred' };
 *
 * _.noop(object) === undefined;
 * // => true
 */
function noop() {
  // No operation performed.
}

module.exports = noop;

},{}],83:[function(require,module,exports){
var apply = require('./_apply'),
    toInteger = require('./toInteger');

/** Used as the `TypeError` message for "Functions" methods. */
var FUNC_ERROR_TEXT = 'Expected a function';

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeMax = Math.max;

/**
 * Creates a function that invokes `func` with the `this` binding of the
 * created function and arguments from `start` and beyond provided as
 * an array.
 *
 * **Note:** This method is based on the
 * [rest parameter](https://mdn.io/rest_parameters).
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Function
 * @param {Function} func The function to apply a rest parameter to.
 * @param {number} [start=func.length-1] The start position of the rest parameter.
 * @returns {Function} Returns the new function.
 * @example
 *
 * var say = _.rest(function(what, names) {
 *   return what + ' ' + _.initial(names).join(', ') +
 *     (_.size(names) > 1 ? ', & ' : '') + _.last(names);
 * });
 *
 * say('hello', 'fred', 'barney', 'pebbles');
 * // => 'hello fred, barney, & pebbles'
 */
function rest(func, start) {
  if (typeof func != 'function') {
    throw new TypeError(FUNC_ERROR_TEXT);
  }
  start = nativeMax(start === undefined ? (func.length - 1) : toInteger(start), 0);
  return function() {
    var args = arguments,
        index = -1,
        length = nativeMax(args.length - start, 0),
        array = Array(length);

    while (++index < length) {
      array[index] = args[start + index];
    }
    switch (start) {
      case 0: return func.call(this, array);
      case 1: return func.call(this, args[0], array);
      case 2: return func.call(this, args[0], args[1], array);
    }
    var otherArgs = Array(start + 1);
    index = -1;
    while (++index < start) {
      otherArgs[index] = args[index];
    }
    otherArgs[start] = array;
    return apply(func, this, otherArgs);
  };
}

module.exports = rest;

},{"./_apply":30,"./toInteger":84}],84:[function(require,module,exports){
var toNumber = require('./toNumber');

/** Used as references for various `Number` constants. */
var INFINITY = 1 / 0,
    MAX_INTEGER = 1.7976931348623157e+308;

/**
 * Converts `value` to an integer.
 *
 * **Note:** This function is loosely based on
 * [`ToInteger`](http://www.ecma-international.org/ecma-262/6.0/#sec-tointeger).
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to convert.
 * @returns {number} Returns the converted integer.
 * @example
 *
 * _.toInteger(3);
 * // => 3
 *
 * _.toInteger(Number.MIN_VALUE);
 * // => 0
 *
 * _.toInteger(Infinity);
 * // => 1.7976931348623157e+308
 *
 * _.toInteger('3');
 * // => 3
 */
function toInteger(value) {
  if (!value) {
    return value === 0 ? value : 0;
  }
  value = toNumber(value);
  if (value === INFINITY || value === -INFINITY) {
    var sign = (value < 0 ? -1 : 1);
    return sign * MAX_INTEGER;
  }
  var remainder = value % 1;
  return value === value ? (remainder ? value - remainder : value) : 0;
}

module.exports = toInteger;

},{"./toNumber":85}],85:[function(require,module,exports){
var isFunction = require('./isFunction'),
    isObject = require('./isObject'),
    isSymbol = require('./isSymbol');

/** Used as references for various `Number` constants. */
var NAN = 0 / 0;

/** Used to match leading and trailing whitespace. */
var reTrim = /^\s+|\s+$/g;

/** Used to detect bad signed hexadecimal string values. */
var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;

/** Used to detect binary string values. */
var reIsBinary = /^0b[01]+$/i;

/** Used to detect octal string values. */
var reIsOctal = /^0o[0-7]+$/i;

/** Built-in method references without a dependency on `root`. */
var freeParseInt = parseInt;

/**
 * Converts `value` to a number.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to process.
 * @returns {number} Returns the number.
 * @example
 *
 * _.toNumber(3);
 * // => 3
 *
 * _.toNumber(Number.MIN_VALUE);
 * // => 5e-324
 *
 * _.toNumber(Infinity);
 * // => Infinity
 *
 * _.toNumber('3');
 * // => 3
 */
function toNumber(value) {
  if (typeof value == 'number') {
    return value;
  }
  if (isSymbol(value)) {
    return NAN;
  }
  if (isObject(value)) {
    var other = isFunction(value.valueOf) ? value.valueOf() : value;
    value = isObject(other) ? (other + '') : other;
  }
  if (typeof value != 'string') {
    return value === 0 ? value : +value;
  }
  value = value.replace(reTrim, '');
  var isBinary = reIsBinary.test(value);
  return (isBinary || reIsOctal.test(value))
    ? freeParseInt(value.slice(2), isBinary ? 2 : 8)
    : (reIsBadHex.test(value) ? NAN : +value);
}

module.exports = toNumber;

},{"./isFunction":76,"./isObject":79,"./isSymbol":81}],86:[function(require,module,exports){
var baseDifference = require('./_baseDifference'),
    isArrayLikeObject = require('./isArrayLikeObject'),
    rest = require('./rest');

/**
 * Creates an array excluding all given values using
 * [`SameValueZero`](http://ecma-international.org/ecma-262/6.0/#sec-samevaluezero)
 * for equality comparisons.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Array
 * @param {Array} array The array to filter.
 * @param {...*} [values] The values to exclude.
 * @returns {Array} Returns the new array of filtered values.
 * @example
 *
 * _.without([1, 2, 1, 3], 1, 2);
 * // => [3]
 */
var without = rest(function(array, values) {
  return isArrayLikeObject(array)
    ? baseDifference(array, values)
    : [];
});

module.exports = without;

},{"./_baseDifference":41,"./isArrayLikeObject":75,"./rest":83}],87:[function(require,module,exports){
var arrayFilter = require('./_arrayFilter'),
    baseXor = require('./_baseXor'),
    isArrayLikeObject = require('./isArrayLikeObject'),
    rest = require('./rest');

/**
 * Creates an array of unique values that is the
 * [symmetric difference](https://en.wikipedia.org/wiki/Symmetric_difference)
 * of the given arrays. The order of result values is determined by the order
 * they occur in the arrays.
 *
 * @static
 * @memberOf _
 * @since 2.4.0
 * @category Array
 * @param {...Array} [arrays] The arrays to inspect.
 * @returns {Array} Returns the new array of values.
 * @example
 *
 * _.xor([2, 1], [4, 2]);
 * // => [1, 4]
 */
var xor = rest(function(arrays) {
  return baseXor(arrayFilter(arrays, isArrayLikeObject));
});

module.exports = xor;

},{"./_arrayFilter":31,"./_baseXor":47,"./isArrayLikeObject":75,"./rest":83}],88:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

'use strict';

/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if (process.env.NODE_ENV !== 'production') {
    if (format === undefined) {
      throw new Error('invariant requires an error message argument');
    }
  }

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
      error.name = 'Invariant Violation';
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;

}).call(this,require('_process'))

},{"_process":89}],89:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],90:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _lodashMemoize = require('lodash/memoize');

var _lodashMemoize2 = _interopRequireDefault(_lodashMemoize);

var isFirefox = _lodashMemoize2['default'](function () {
  return (/firefox/i.test(navigator.userAgent)
  );
});

exports.isFirefox = isFirefox;
var isSafari = _lodashMemoize2['default'](function () {
  return Boolean(window.safari);
});
exports.isSafari = isSafari;
},{"lodash/memoize":171}],91:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _lodashUnion = require('lodash/union');

var _lodashUnion2 = _interopRequireDefault(_lodashUnion);

var _lodashWithout = require('lodash/without');

var _lodashWithout2 = _interopRequireDefault(_lodashWithout);

var EnterLeaveCounter = (function () {
  function EnterLeaveCounter() {
    _classCallCheck(this, EnterLeaveCounter);

    this.entered = [];
  }

  EnterLeaveCounter.prototype.enter = function enter(enteringNode) {
    var previousLength = this.entered.length;

    this.entered = _lodashUnion2['default'](this.entered.filter(function (node) {
      return document.documentElement.contains(node) && (!node.contains || node.contains(enteringNode));
    }), [enteringNode]);

    return previousLength === 0 && this.entered.length > 0;
  };

  EnterLeaveCounter.prototype.leave = function leave(leavingNode) {
    var previousLength = this.entered.length;

    this.entered = _lodashWithout2['default'](this.entered.filter(function (node) {
      return document.documentElement.contains(node);
    }), leavingNode);

    return previousLength > 0 && this.entered.length === 0;
  };

  EnterLeaveCounter.prototype.reset = function reset() {
    this.entered = [];
  };

  return EnterLeaveCounter;
})();

exports['default'] = EnterLeaveCounter;
module.exports = exports['default'];
},{"lodash/union":176,"lodash/without":177}],92:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _lodashDefaults = require('lodash/defaults');

var _lodashDefaults2 = _interopRequireDefault(_lodashDefaults);

var _shallowEqual = require('./shallowEqual');

var _shallowEqual2 = _interopRequireDefault(_shallowEqual);

var _EnterLeaveCounter = require('./EnterLeaveCounter');

var _EnterLeaveCounter2 = _interopRequireDefault(_EnterLeaveCounter);

var _BrowserDetector = require('./BrowserDetector');

var _OffsetUtils = require('./OffsetUtils');

var _NativeDragSources = require('./NativeDragSources');

var _NativeTypes = require('./NativeTypes');

var NativeTypes = _interopRequireWildcard(_NativeTypes);

var HTML5Backend = (function () {
  function HTML5Backend(manager) {
    _classCallCheck(this, HTML5Backend);

    this.actions = manager.getActions();
    this.monitor = manager.getMonitor();
    this.registry = manager.getRegistry();

    this.sourcePreviewNodes = {};
    this.sourcePreviewNodeOptions = {};
    this.sourceNodes = {};
    this.sourceNodeOptions = {};
    this.enterLeaveCounter = new _EnterLeaveCounter2['default']();

    this.getSourceClientOffset = this.getSourceClientOffset.bind(this);
    this.handleTopDragStart = this.handleTopDragStart.bind(this);
    this.handleTopDragStartCapture = this.handleTopDragStartCapture.bind(this);
    this.handleTopDragEndCapture = this.handleTopDragEndCapture.bind(this);
    this.handleTopDragEnter = this.handleTopDragEnter.bind(this);
    this.handleTopDragEnterCapture = this.handleTopDragEnterCapture.bind(this);
    this.handleTopDragLeaveCapture = this.handleTopDragLeaveCapture.bind(this);
    this.handleTopDragOver = this.handleTopDragOver.bind(this);
    this.handleTopDragOverCapture = this.handleTopDragOverCapture.bind(this);
    this.handleTopDrop = this.handleTopDrop.bind(this);
    this.handleTopDropCapture = this.handleTopDropCapture.bind(this);
    this.handleSelectStart = this.handleSelectStart.bind(this);
    this.endDragIfSourceWasRemovedFromDOM = this.endDragIfSourceWasRemovedFromDOM.bind(this);
    this.endDragNativeItem = this.endDragNativeItem.bind(this);
  }

  HTML5Backend.prototype.setup = function setup() {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.constructor.isSetUp) {
      throw new Error('Cannot have two HTML5 backends at the same time.');
    }
    this.constructor.isSetUp = true;
    this.addEventListeners(window);
  };

  HTML5Backend.prototype.teardown = function teardown() {
    if (typeof window === 'undefined') {
      return;
    }

    this.constructor.isSetUp = false;
    this.removeEventListeners(window);
    this.clearCurrentDragSourceNode();
  };

  HTML5Backend.prototype.addEventListeners = function addEventListeners(target) {
    target.addEventListener('dragstart', this.handleTopDragStart);
    target.addEventListener('dragstart', this.handleTopDragStartCapture, true);
    target.addEventListener('dragend', this.handleTopDragEndCapture, true);
    target.addEventListener('dragenter', this.handleTopDragEnter);
    target.addEventListener('dragenter', this.handleTopDragEnterCapture, true);
    target.addEventListener('dragleave', this.handleTopDragLeaveCapture, true);
    target.addEventListener('dragover', this.handleTopDragOver);
    target.addEventListener('dragover', this.handleTopDragOverCapture, true);
    target.addEventListener('drop', this.handleTopDrop);
    target.addEventListener('drop', this.handleTopDropCapture, true);
  };

  HTML5Backend.prototype.removeEventListeners = function removeEventListeners(target) {
    target.removeEventListener('dragstart', this.handleTopDragStart);
    target.removeEventListener('dragstart', this.handleTopDragStartCapture, true);
    target.removeEventListener('dragend', this.handleTopDragEndCapture, true);
    target.removeEventListener('dragenter', this.handleTopDragEnter);
    target.removeEventListener('dragenter', this.handleTopDragEnterCapture, true);
    target.removeEventListener('dragleave', this.handleTopDragLeaveCapture, true);
    target.removeEventListener('dragover', this.handleTopDragOver);
    target.removeEventListener('dragover', this.handleTopDragOverCapture, true);
    target.removeEventListener('drop', this.handleTopDrop);
    target.removeEventListener('drop', this.handleTopDropCapture, true);
  };

  HTML5Backend.prototype.connectDragPreview = function connectDragPreview(sourceId, node, options) {
    var _this = this;

    this.sourcePreviewNodeOptions[sourceId] = options;
    this.sourcePreviewNodes[sourceId] = node;

    return function () {
      delete _this.sourcePreviewNodes[sourceId];
      delete _this.sourcePreviewNodeOptions[sourceId];
    };
  };

  HTML5Backend.prototype.connectDragSource = function connectDragSource(sourceId, node, options) {
    var _this2 = this;

    this.sourceNodes[sourceId] = node;
    this.sourceNodeOptions[sourceId] = options;

    var handleDragStart = function handleDragStart(e) {
      return _this2.handleDragStart(e, sourceId);
    };
    var handleSelectStart = function handleSelectStart(e) {
      return _this2.handleSelectStart(e, sourceId);
    };

    node.setAttribute('draggable', true);
    node.addEventListener('dragstart', handleDragStart);
    node.addEventListener('selectstart', handleSelectStart);

    return function () {
      delete _this2.sourceNodes[sourceId];
      delete _this2.sourceNodeOptions[sourceId];

      node.removeEventListener('dragstart', handleDragStart);
      node.removeEventListener('selectstart', handleSelectStart);
      node.setAttribute('draggable', false);
    };
  };

  HTML5Backend.prototype.connectDropTarget = function connectDropTarget(targetId, node) {
    var _this3 = this;

    var handleDragEnter = function handleDragEnter(e) {
      return _this3.handleDragEnter(e, targetId);
    };
    var handleDragOver = function handleDragOver(e) {
      return _this3.handleDragOver(e, targetId);
    };
    var handleDrop = function handleDrop(e) {
      return _this3.handleDrop(e, targetId);
    };

    node.addEventListener('dragenter', handleDragEnter);
    node.addEventListener('dragover', handleDragOver);
    node.addEventListener('drop', handleDrop);

    return function () {
      node.removeEventListener('dragenter', handleDragEnter);
      node.removeEventListener('dragover', handleDragOver);
      node.removeEventListener('drop', handleDrop);
    };
  };

  HTML5Backend.prototype.getCurrentSourceNodeOptions = function getCurrentSourceNodeOptions() {
    var sourceId = this.monitor.getSourceId();
    var sourceNodeOptions = this.sourceNodeOptions[sourceId];

    return _lodashDefaults2['default'](sourceNodeOptions || {}, {
      dropEffect: 'move'
    });
  };

  HTML5Backend.prototype.getCurrentDropEffect = function getCurrentDropEffect() {
    if (this.isDraggingNativeItem()) {
      // It makes more sense to default to 'copy' for native resources
      return 'copy';
    }

    return this.getCurrentSourceNodeOptions().dropEffect;
  };

  HTML5Backend.prototype.getCurrentSourcePreviewNodeOptions = function getCurrentSourcePreviewNodeOptions() {
    var sourceId = this.monitor.getSourceId();
    var sourcePreviewNodeOptions = this.sourcePreviewNodeOptions[sourceId];

    return _lodashDefaults2['default'](sourcePreviewNodeOptions || {}, {
      anchorX: 0.5,
      anchorY: 0.5,
      captureDraggingState: false
    });
  };

  HTML5Backend.prototype.getSourceClientOffset = function getSourceClientOffset(sourceId) {
    return _OffsetUtils.getNodeClientOffset(this.sourceNodes[sourceId]);
  };

  HTML5Backend.prototype.isDraggingNativeItem = function isDraggingNativeItem() {
    var itemType = this.monitor.getItemType();
    return Object.keys(NativeTypes).some(function (key) {
      return NativeTypes[key] === itemType;
    });
  };

  HTML5Backend.prototype.beginDragNativeItem = function beginDragNativeItem(type) {
    this.clearCurrentDragSourceNode();

    var SourceType = _NativeDragSources.createNativeDragSource(type);
    this.currentNativeSource = new SourceType();
    this.currentNativeHandle = this.registry.addSource(type, this.currentNativeSource);
    this.actions.beginDrag([this.currentNativeHandle]);

    // On Firefox, if mousemove fires, the drag is over but browser failed to tell us.
    // This is not true for other browsers.
    if (_BrowserDetector.isFirefox()) {
      window.addEventListener('mousemove', this.endDragNativeItem, true);
    }
  };

  HTML5Backend.prototype.endDragNativeItem = function endDragNativeItem() {
    if (!this.isDraggingNativeItem()) {
      return;
    }

    if (_BrowserDetector.isFirefox()) {
      window.removeEventListener('mousemove', this.endDragNativeItem, true);
    }

    this.actions.endDrag();
    this.registry.removeSource(this.currentNativeHandle);
    this.currentNativeHandle = null;
    this.currentNativeSource = null;
  };

  HTML5Backend.prototype.endDragIfSourceWasRemovedFromDOM = function endDragIfSourceWasRemovedFromDOM() {
    var node = this.currentDragSourceNode;
    if (document.body.contains(node)) {
      return;
    }

    if (this.clearCurrentDragSourceNode()) {
      this.actions.endDrag();
    }
  };

  HTML5Backend.prototype.setCurrentDragSourceNode = function setCurrentDragSourceNode(node) {
    this.clearCurrentDragSourceNode();
    this.currentDragSourceNode = node;
    this.currentDragSourceNodeOffset = _OffsetUtils.getNodeClientOffset(node);
    this.currentDragSourceNodeOffsetChanged = false;

    // Receiving a mouse event in the middle of a dragging operation
    // means it has ended and the drag source node disappeared from DOM,
    // so the browser didn't dispatch the dragend event.
    window.addEventListener('mousemove', this.endDragIfSourceWasRemovedFromDOM, true);
  };

  HTML5Backend.prototype.clearCurrentDragSourceNode = function clearCurrentDragSourceNode() {
    if (this.currentDragSourceNode) {
      this.currentDragSourceNode = null;
      this.currentDragSourceNodeOffset = null;
      this.currentDragSourceNodeOffsetChanged = false;
      window.removeEventListener('mousemove', this.endDragIfSourceWasRemovedFromDOM, true);
      return true;
    }

    return false;
  };

  HTML5Backend.prototype.checkIfCurrentDragSourceRectChanged = function checkIfCurrentDragSourceRectChanged() {
    var node = this.currentDragSourceNode;
    if (!node) {
      return false;
    }

    if (this.currentDragSourceNodeOffsetChanged) {
      return true;
    }

    this.currentDragSourceNodeOffsetChanged = !_shallowEqual2['default'](_OffsetUtils.getNodeClientOffset(node), this.currentDragSourceNodeOffset);

    return this.currentDragSourceNodeOffsetChanged;
  };

  HTML5Backend.prototype.handleTopDragStartCapture = function handleTopDragStartCapture() {
    this.clearCurrentDragSourceNode();
    this.dragStartSourceIds = [];
  };

  HTML5Backend.prototype.handleDragStart = function handleDragStart(e, sourceId) {
    this.dragStartSourceIds.unshift(sourceId);
  };

  HTML5Backend.prototype.handleTopDragStart = function handleTopDragStart(e) {
    var _this4 = this;

    var dragStartSourceIds = this.dragStartSourceIds;

    this.dragStartSourceIds = null;

    var clientOffset = _OffsetUtils.getEventClientOffset(e);

    // Don't publish the source just yet (see why below)
    this.actions.beginDrag(dragStartSourceIds, {
      publishSource: false,
      getSourceClientOffset: this.getSourceClientOffset,
      clientOffset: clientOffset
    });

    var dataTransfer = e.dataTransfer;

    var nativeType = _NativeDragSources.matchNativeItemType(dataTransfer);

    if (this.monitor.isDragging()) {
      if (typeof dataTransfer.setDragImage === 'function') {
        // Use custom drag image if user specifies it.
        // If child drag source refuses drag but parent agrees,
        // use parent's node as drag image. Neither works in IE though.
        var sourceId = this.monitor.getSourceId();
        var sourceNode = this.sourceNodes[sourceId];
        var dragPreview = this.sourcePreviewNodes[sourceId] || sourceNode;

        var _getCurrentSourcePreviewNodeOptions = this.getCurrentSourcePreviewNodeOptions();

        var anchorX = _getCurrentSourcePreviewNodeOptions.anchorX;
        var anchorY = _getCurrentSourcePreviewNodeOptions.anchorY;

        var anchorPoint = { anchorX: anchorX, anchorY: anchorY };
        var dragPreviewOffset = _OffsetUtils.getDragPreviewOffset(sourceNode, dragPreview, clientOffset, anchorPoint);
        dataTransfer.setDragImage(dragPreview, dragPreviewOffset.x, dragPreviewOffset.y);
      }

      try {
        // Firefox won't drag without setting data
        dataTransfer.setData('application/json', {});
      } catch (err) {}
      // IE doesn't support MIME types in setData

      // Store drag source node so we can check whether
      // it is removed from DOM and trigger endDrag manually.
      this.setCurrentDragSourceNode(e.target);

      // Now we are ready to publish the drag source.. or are we not?

      var _getCurrentSourcePreviewNodeOptions2 = this.getCurrentSourcePreviewNodeOptions();

      var captureDraggingState = _getCurrentSourcePreviewNodeOptions2.captureDraggingState;

      if (!captureDraggingState) {
        // Usually we want to publish it in the next tick so that browser
        // is able to screenshot the current (not yet dragging) state.
        //
        // It also neatly avoids a situation where render() returns null
        // in the same tick for the source element, and browser freaks out.
        setTimeout(function () {
          return _this4.actions.publishDragSource();
        });
      } else {
        // In some cases the user may want to override this behavior, e.g.
        // to work around IE not supporting custom drag previews.
        //
        // When using a custom drag layer, the only way to prevent
        // the default drag preview from drawing in IE is to screenshot
        // the dragging state in which the node itself has zero opacity
        // and height. In this case, though, returning null from render()
        // will abruptly end the dragging, which is not obvious.
        //
        // This is the reason such behavior is strictly opt-in.
        this.actions.publishDragSource();
      }
    } else if (nativeType) {
      // A native item (such as URL) dragged from inside the document
      this.beginDragNativeItem(nativeType);
    } else if (!dataTransfer.types && (!e.target.hasAttribute || !e.target.hasAttribute('draggable'))) {
      // Looks like a Safari bug: dataTransfer.types is null, but there was no draggable.
      // Just let it drag. It's a native type (URL or text) and will be picked up in dragenter handler.
      return;
    } else {
      // If by this time no drag source reacted, tell browser not to drag.
      e.preventDefault();
    }
  };

  HTML5Backend.prototype.handleTopDragEndCapture = function handleTopDragEndCapture() {
    if (this.clearCurrentDragSourceNode()) {
      // Firefox can dispatch this event in an infinite loop
      // if dragend handler does something like showing an alert.
      // Only proceed if we have not handled it already.
      this.actions.endDrag();
    }
  };

  HTML5Backend.prototype.handleTopDragEnterCapture = function handleTopDragEnterCapture(e) {
    this.dragEnterTargetIds = [];

    var isFirstEnter = this.enterLeaveCounter.enter(e.target);
    if (!isFirstEnter || this.monitor.isDragging()) {
      return;
    }

    var dataTransfer = e.dataTransfer;

    var nativeType = _NativeDragSources.matchNativeItemType(dataTransfer);

    if (nativeType) {
      // A native item (such as file or URL) dragged from outside the document
      this.beginDragNativeItem(nativeType);
    }
  };

  HTML5Backend.prototype.handleDragEnter = function handleDragEnter(e, targetId) {
    this.dragEnterTargetIds.unshift(targetId);
  };

  HTML5Backend.prototype.handleTopDragEnter = function handleTopDragEnter(e) {
    var _this5 = this;

    var dragEnterTargetIds = this.dragEnterTargetIds;

    this.dragEnterTargetIds = [];

    if (!this.monitor.isDragging()) {
      // This is probably a native item type we don't understand.
      return;
    }

    if (!_BrowserDetector.isFirefox()) {
      // Don't emit hover in `dragenter` on Firefox due to an edge case.
      // If the target changes position as the result of `dragenter`, Firefox
      // will still happily dispatch `dragover` despite target being no longer
      // there. The easy solution is to only fire `hover` in `dragover` on FF.
      this.actions.hover(dragEnterTargetIds, {
        clientOffset: _OffsetUtils.getEventClientOffset(e)
      });
    }

    var canDrop = dragEnterTargetIds.some(function (targetId) {
      return _this5.monitor.canDropOnTarget(targetId);
    });

    if (canDrop) {
      // IE requires this to fire dragover events
      e.preventDefault();
      e.dataTransfer.dropEffect = this.getCurrentDropEffect();
    }
  };

  HTML5Backend.prototype.handleTopDragOverCapture = function handleTopDragOverCapture() {
    this.dragOverTargetIds = [];
  };

  HTML5Backend.prototype.handleDragOver = function handleDragOver(e, targetId) {
    this.dragOverTargetIds.unshift(targetId);
  };

  HTML5Backend.prototype.handleTopDragOver = function handleTopDragOver(e) {
    var _this6 = this;

    var dragOverTargetIds = this.dragOverTargetIds;

    this.dragOverTargetIds = [];

    if (!this.monitor.isDragging()) {
      // This is probably a native item type we don't understand.
      // Prevent default "drop and blow away the whole document" action.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    this.actions.hover(dragOverTargetIds, {
      clientOffset: _OffsetUtils.getEventClientOffset(e)
    });

    var canDrop = dragOverTargetIds.some(function (targetId) {
      return _this6.monitor.canDropOnTarget(targetId);
    });

    if (canDrop) {
      // Show user-specified drop effect.
      e.preventDefault();
      e.dataTransfer.dropEffect = this.getCurrentDropEffect();
    } else if (this.isDraggingNativeItem()) {
      // Don't show a nice cursor but still prevent default
      // "drop and blow away the whole document" action.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    } else if (this.checkIfCurrentDragSourceRectChanged()) {
      // Prevent animating to incorrect position.
      // Drop effect must be other than 'none' to prevent animation.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };

  HTML5Backend.prototype.handleTopDragLeaveCapture = function handleTopDragLeaveCapture(e) {
    if (this.isDraggingNativeItem()) {
      e.preventDefault();
    }

    var isLastLeave = this.enterLeaveCounter.leave(e.target);
    if (!isLastLeave) {
      return;
    }

    if (this.isDraggingNativeItem()) {
      this.endDragNativeItem();
    }
  };

  HTML5Backend.prototype.handleTopDropCapture = function handleTopDropCapture(e) {
    this.dropTargetIds = [];
    e.preventDefault();

    if (this.isDraggingNativeItem()) {
      this.currentNativeSource.mutateItemByReadingDataTransfer(e.dataTransfer);
    }

    this.enterLeaveCounter.reset();
  };

  HTML5Backend.prototype.handleDrop = function handleDrop(e, targetId) {
    this.dropTargetIds.unshift(targetId);
  };

  HTML5Backend.prototype.handleTopDrop = function handleTopDrop(e) {
    var dropTargetIds = this.dropTargetIds;

    this.dropTargetIds = [];

    this.actions.hover(dropTargetIds, {
      clientOffset: _OffsetUtils.getEventClientOffset(e)
    });
    this.actions.drop();

    if (this.isDraggingNativeItem()) {
      this.endDragNativeItem();
    } else {
      this.endDragIfSourceWasRemovedFromDOM();
    }
  };

  HTML5Backend.prototype.handleSelectStart = function handleSelectStart(e) {
    var target = e.target;

    // Only IE requires us to explicitly say
    // we want drag drop operation to start
    if (typeof target.dragDrop !== 'function') {
      return;
    }

    // Inputs and textareas should be selectable
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    // For other targets, ask IE
    // to enable drag and drop
    e.preventDefault();
    target.dragDrop();
  };

  return HTML5Backend;
})();

exports['default'] = HTML5Backend;
module.exports = exports['default'];
},{"./BrowserDetector":90,"./EnterLeaveCounter":91,"./NativeDragSources":94,"./NativeTypes":95,"./OffsetUtils":96,"./shallowEqual":99,"lodash/defaults":157}],93:[function(require,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var MonotonicInterpolant = (function () {
  function MonotonicInterpolant(xs, ys) {
    _classCallCheck(this, MonotonicInterpolant);

    var length = xs.length;

    // Rearrange xs and ys so that xs is sorted
    var indexes = [];
    for (var i = 0; i < length; i++) {
      indexes.push(i);
    }
    indexes.sort(function (a, b) {
      return xs[a] < xs[b] ? -1 : 1;
    });

    // Get consecutive differences and slopes
    var dys = [];
    var dxs = [];
    var ms = [];
    var dx = undefined;
    var dy = undefined;
    for (var i = 0; i < length - 1; i++) {
      dx = xs[i + 1] - xs[i];
      dy = ys[i + 1] - ys[i];
      dxs.push(dx);
      dys.push(dy);
      ms.push(dy / dx);
    }

    // Get degree-1 coefficients
    var c1s = [ms[0]];
    for (var i = 0; i < dxs.length - 1; i++) {
      var _m = ms[i];
      var mNext = ms[i + 1];
      if (_m * mNext <= 0) {
        c1s.push(0);
      } else {
        dx = dxs[i];
        var dxNext = dxs[i + 1];
        var common = dx + dxNext;
        c1s.push(3 * common / ((common + dxNext) / _m + (common + dx) / mNext));
      }
    }
    c1s.push(ms[ms.length - 1]);

    // Get degree-2 and degree-3 coefficients
    var c2s = [];
    var c3s = [];
    var m = undefined;
    for (var i = 0; i < c1s.length - 1; i++) {
      m = ms[i];
      var c1 = c1s[i];
      var invDx = 1 / dxs[i];
      var common = c1 + c1s[i + 1] - m - m;
      c2s.push((m - c1 - common) * invDx);
      c3s.push(common * invDx * invDx);
    }

    this.xs = xs;
    this.ys = ys;
    this.c1s = c1s;
    this.c2s = c2s;
    this.c3s = c3s;
  }

  MonotonicInterpolant.prototype.interpolate = function interpolate(x) {
    var xs = this.xs;
    var ys = this.ys;
    var c1s = this.c1s;
    var c2s = this.c2s;
    var c3s = this.c3s;

    // The rightmost point in the dataset should give an exact result
    var i = xs.length - 1;
    if (x === xs[i]) {
      return ys[i];
    }

    // Search for the interval x is in, returning the corresponding y if x is one of the original xs
    var low = 0;
    var high = c3s.length - 1;
    var mid = undefined;
    while (low <= high) {
      mid = Math.floor(0.5 * (low + high));
      var xHere = xs[mid];
      if (xHere < x) {
        low = mid + 1;
      } else if (xHere > x) {
        high = mid - 1;
      } else {
        return ys[mid];
      }
    }
    i = Math.max(0, high);

    // Interpolate
    var diff = x - xs[i];
    var diffSq = diff * diff;
    return ys[i] + c1s[i] * diff + c2s[i] * diffSq + c3s[i] * diff * diffSq;
  };

  return MonotonicInterpolant;
})();

exports["default"] = MonotonicInterpolant;
module.exports = exports["default"];
},{}],94:[function(require,module,exports){
'use strict';

exports.__esModule = true;

var _nativeTypesConfig;

exports.createNativeDragSource = createNativeDragSource;
exports.matchNativeItemType = matchNativeItemType;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var _NativeTypes = require('./NativeTypes');

var NativeTypes = _interopRequireWildcard(_NativeTypes);

function getDataFromDataTransfer(dataTransfer, typesToTry, defaultValue) {
  var result = typesToTry.reduce(function (resultSoFar, typeToTry) {
    return resultSoFar || dataTransfer.getData(typeToTry);
  }, null);

  return result != null ? // eslint-disable-line eqeqeq
  result : defaultValue;
}

var nativeTypesConfig = (_nativeTypesConfig = {}, _defineProperty(_nativeTypesConfig, NativeTypes.FILE, {
  exposeProperty: 'files',
  matchesTypes: ['Files'],
  getData: function getData(dataTransfer) {
    return Array.prototype.slice.call(dataTransfer.files);
  }
}), _defineProperty(_nativeTypesConfig, NativeTypes.URL, {
  exposeProperty: 'urls',
  matchesTypes: ['Url', 'text/uri-list'],
  getData: function getData(dataTransfer, matchesTypes) {
    return getDataFromDataTransfer(dataTransfer, matchesTypes, '').split('\n');
  }
}), _defineProperty(_nativeTypesConfig, NativeTypes.TEXT, {
  exposeProperty: 'text',
  matchesTypes: ['Text', 'text/plain'],
  getData: function getData(dataTransfer, matchesTypes) {
    return getDataFromDataTransfer(dataTransfer, matchesTypes, '');
  }
}), _nativeTypesConfig);

function createNativeDragSource(type) {
  var _nativeTypesConfig$type = nativeTypesConfig[type];
  var exposeProperty = _nativeTypesConfig$type.exposeProperty;
  var matchesTypes = _nativeTypesConfig$type.matchesTypes;
  var getData = _nativeTypesConfig$type.getData;

  return (function () {
    function NativeDragSource() {
      _classCallCheck(this, NativeDragSource);

      this.item = Object.defineProperties({}, _defineProperty({}, exposeProperty, {
        get: function get() {
          console.warn( // eslint-disable-line no-console
          'Browser doesn\'t allow reading "' + exposeProperty + '" until the drop event.');
          return null;
        },
        configurable: true,
        enumerable: true
      }));
    }

    NativeDragSource.prototype.mutateItemByReadingDataTransfer = function mutateItemByReadingDataTransfer(dataTransfer) {
      delete this.item[exposeProperty];
      this.item[exposeProperty] = getData(dataTransfer, matchesTypes);
    };

    NativeDragSource.prototype.canDrag = function canDrag() {
      return true;
    };

    NativeDragSource.prototype.beginDrag = function beginDrag() {
      return this.item;
    };

    NativeDragSource.prototype.isDragging = function isDragging(monitor, handle) {
      return handle === monitor.getSourceId();
    };

    NativeDragSource.prototype.endDrag = function endDrag() {};

    return NativeDragSource;
  })();
}

function matchNativeItemType(dataTransfer) {
  var dataTransferTypes = Array.prototype.slice.call(dataTransfer.types || []);

  return Object.keys(nativeTypesConfig).filter(function (nativeItemType) {
    var matchesTypes = nativeTypesConfig[nativeItemType].matchesTypes;

    return matchesTypes.some(function (t) {
      return dataTransferTypes.indexOf(t) > -1;
    });
  })[0] || null;
}
},{"./NativeTypes":95}],95:[function(require,module,exports){
'use strict';

exports.__esModule = true;
var FILE = '__NATIVE_FILE__';
exports.FILE = FILE;
var URL = '__NATIVE_URL__';
exports.URL = URL;
var TEXT = '__NATIVE_TEXT__';
exports.TEXT = TEXT;
},{}],96:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports.getNodeClientOffset = getNodeClientOffset;
exports.getEventClientOffset = getEventClientOffset;
exports.getDragPreviewOffset = getDragPreviewOffset;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _BrowserDetector = require('./BrowserDetector');

var _MonotonicInterpolant = require('./MonotonicInterpolant');

var _MonotonicInterpolant2 = _interopRequireDefault(_MonotonicInterpolant);

var ELEMENT_NODE = 1;

function getNodeClientOffset(node) {
  var el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;

  if (!el) {
    return null;
  }

  var _el$getBoundingClientRect = el.getBoundingClientRect();

  var top = _el$getBoundingClientRect.top;
  var left = _el$getBoundingClientRect.left;

  return { x: left, y: top };
}

function getEventClientOffset(e) {
  return {
    x: e.clientX,
    y: e.clientY
  };
}

function getDragPreviewOffset(sourceNode, dragPreview, clientOffset, anchorPoint) {
  // The browsers will use the image intrinsic size under different conditions.
  // Firefox only cares if it's an image, but WebKit also wants it to be detached.
  var isImage = dragPreview.nodeName === 'IMG' && (_BrowserDetector.isFirefox() || !document.documentElement.contains(dragPreview));
  var dragPreviewNode = isImage ? sourceNode : dragPreview;

  var dragPreviewNodeOffsetFromClient = getNodeClientOffset(dragPreviewNode);
  var offsetFromDragPreview = {
    x: clientOffset.x - dragPreviewNodeOffsetFromClient.x,
    y: clientOffset.y - dragPreviewNodeOffsetFromClient.y
  };

  var sourceWidth = sourceNode.offsetWidth;
  var sourceHeight = sourceNode.offsetHeight;
  var anchorX = anchorPoint.anchorX;
  var anchorY = anchorPoint.anchorY;

  var dragPreviewWidth = isImage ? dragPreview.width : sourceWidth;
  var dragPreviewHeight = isImage ? dragPreview.height : sourceHeight;

  // Work around @2x coordinate discrepancies in browsers
  if (_BrowserDetector.isSafari() && isImage) {
    dragPreviewHeight /= window.devicePixelRatio;
    dragPreviewWidth /= window.devicePixelRatio;
  } else if (_BrowserDetector.isFirefox() && !isImage) {
    dragPreviewHeight *= window.devicePixelRatio;
    dragPreviewWidth *= window.devicePixelRatio;
  }

  // Interpolate coordinates depending on anchor point
  // If you know a simpler way to do this, let me know
  var interpolantX = new _MonotonicInterpolant2['default']([0, 0.5, 1], [
  // Dock to the left
  offsetFromDragPreview.x,
  // Align at the center
  offsetFromDragPreview.x / sourceWidth * dragPreviewWidth,
  // Dock to the right
  offsetFromDragPreview.x + dragPreviewWidth - sourceWidth]);
  var interpolantY = new _MonotonicInterpolant2['default']([0, 0.5, 1], [
  // Dock to the top
  offsetFromDragPreview.y,
  // Align at the center
  offsetFromDragPreview.y / sourceHeight * dragPreviewHeight,
  // Dock to the bottom
  offsetFromDragPreview.y + dragPreviewHeight - sourceHeight]);
  var x = interpolantX.interpolate(anchorX);
  var y = interpolantY.interpolate(anchorY);

  // Work around Safari 8 positioning bug
  if (_BrowserDetector.isSafari() && isImage) {
    // We'll have to wait for @3x to see if this is entirely correct
    y += (window.devicePixelRatio - 1) * dragPreviewHeight;
  }

  return { x: x, y: y };
}
},{"./BrowserDetector":90,"./MonotonicInterpolant":93}],97:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = getEmptyImage;
var emptyImage = undefined;

function getEmptyImage() {
  if (!emptyImage) {
    emptyImage = new Image();
    emptyImage.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  }

  return emptyImage;
}

module.exports = exports['default'];
},{}],98:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createHTML5Backend;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj['default'] = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _HTML5Backend = require('./HTML5Backend');

var _HTML5Backend2 = _interopRequireDefault(_HTML5Backend);

var _getEmptyImage = require('./getEmptyImage');

var _getEmptyImage2 = _interopRequireDefault(_getEmptyImage);

var _NativeTypes = require('./NativeTypes');

var NativeTypes = _interopRequireWildcard(_NativeTypes);

exports.NativeTypes = NativeTypes;
exports.getEmptyImage = _getEmptyImage2['default'];

function createHTML5Backend(manager) {
  return new _HTML5Backend2['default'](manager);
}
},{"./HTML5Backend":92,"./NativeTypes":95,"./getEmptyImage":97}],99:[function(require,module,exports){
"use strict";

exports.__esModule = true;
exports["default"] = shallowEqual;

function shallowEqual(objA, objB) {
  if (objA === objB) {
    return true;
  }

  var keysA = Object.keys(objA);
  var keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  // Test for A's keys different from B.
  var hasOwn = Object.prototype.hasOwnProperty;
  for (var i = 0; i < keysA.length; i++) {
    if (!hasOwn.call(objB, keysA[i]) || objA[keysA[i]] !== objB[keysA[i]]) {
      return false;
    }

    var valA = objA[keysA[i]];
    var valB = objB[keysA[i]];

    if (valA !== valB) {
      return false;
    }
  }

  return true;
}

module.exports = exports["default"];
},{}],100:[function(require,module,exports){
arguments[4][25][0].apply(exports,arguments)
},{"./_nativeCreate":152,"dup":25}],101:[function(require,module,exports){
arguments[4][26][0].apply(exports,arguments)
},{"./_getNative":133,"./_root":153,"dup":26}],102:[function(require,module,exports){
arguments[4][27][0].apply(exports,arguments)
},{"./_mapClear":147,"./_mapDelete":148,"./_mapGet":149,"./_mapHas":150,"./_mapSet":151,"dup":27}],103:[function(require,module,exports){
var root = require('./_root');

/** Built-in value references. */
var Reflect = root.Reflect;

module.exports = Reflect;

},{"./_root":153}],104:[function(require,module,exports){
arguments[4][28][0].apply(exports,arguments)
},{"./_getNative":133,"./_root":153,"dup":28}],105:[function(require,module,exports){
arguments[4][29][0].apply(exports,arguments)
},{"./_MapCache":102,"./_cachePush":127,"dup":29}],106:[function(require,module,exports){
arguments[4][30][0].apply(exports,arguments)
},{"dup":30}],107:[function(require,module,exports){
arguments[4][32][0].apply(exports,arguments)
},{"./_baseIndexOf":120,"dup":32}],108:[function(require,module,exports){
arguments[4][33][0].apply(exports,arguments)
},{"dup":33}],109:[function(require,module,exports){
arguments[4][34][0].apply(exports,arguments)
},{"dup":34}],110:[function(require,module,exports){
arguments[4][35][0].apply(exports,arguments)
},{"dup":35}],111:[function(require,module,exports){
var eq = require('./eq');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used by `_.defaults` to customize its `_.assignIn` use.
 *
 * @private
 * @param {*} objValue The destination value.
 * @param {*} srcValue The source value.
 * @param {string} key The key of the property to assign.
 * @param {Object} object The parent object of `objValue`.
 * @returns {*} Returns the value to assign.
 */
function assignInDefaults(objValue, srcValue, key, object) {
  if (objValue === undefined ||
      (eq(objValue, objectProto[key]) && !hasOwnProperty.call(object, key))) {
    return srcValue;
  }
  return objValue;
}

module.exports = assignInDefaults;

},{"./eq":158}],112:[function(require,module,exports){
var eq = require('./eq');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Assigns `value` to `key` of `object` if the existing value is not equivalent
 * using [`SameValueZero`](http://ecma-international.org/ecma-262/6.0/#sec-samevaluezero)
 * for equality comparisons.
 *
 * @private
 * @param {Object} object The object to modify.
 * @param {string} key The key of the property to assign.
 * @param {*} value The value to assign.
 */
function assignValue(object, key, value) {
  var objValue = object[key];
  if (!(hasOwnProperty.call(object, key) && eq(objValue, value)) ||
      (value === undefined && !(key in object))) {
    object[key] = value;
  }
}

module.exports = assignValue;

},{"./eq":158}],113:[function(require,module,exports){
arguments[4][36][0].apply(exports,arguments)
},{"./_assocIndexOf":116,"dup":36}],114:[function(require,module,exports){
arguments[4][37][0].apply(exports,arguments)
},{"./_assocIndexOf":116,"dup":37}],115:[function(require,module,exports){
arguments[4][38][0].apply(exports,arguments)
},{"./_assocIndexOf":116,"dup":38}],116:[function(require,module,exports){
arguments[4][39][0].apply(exports,arguments)
},{"./eq":158,"dup":39}],117:[function(require,module,exports){
arguments[4][40][0].apply(exports,arguments)
},{"./_assocIndexOf":116,"dup":40}],118:[function(require,module,exports){
arguments[4][41][0].apply(exports,arguments)
},{"./_SetCache":105,"./_arrayIncludes":107,"./_arrayIncludesWith":108,"./_arrayMap":109,"./_baseUnary":124,"./_cacheHas":126,"dup":41}],119:[function(require,module,exports){
var arrayPush = require('./_arrayPush'),
    isFlattenable = require('./_isFlattenable');

/**
 * The base implementation of `_.flatten` with support for restricting flattening.
 *
 * @private
 * @param {Array} array The array to flatten.
 * @param {number} depth The maximum recursion depth.
 * @param {boolean} [predicate=isFlattenable] The function invoked per iteration.
 * @param {boolean} [isStrict] Restrict to values that pass `predicate` checks.
 * @param {Array} [result=[]] The initial result value.
 * @returns {Array} Returns the new flattened array.
 */
function baseFlatten(array, depth, predicate, isStrict, result) {
  var index = -1,
      length = array.length;

  predicate || (predicate = isFlattenable);
  result || (result = []);

  while (++index < length) {
    var value = array[index];
    if (depth > 0 && predicate(value)) {
      if (depth > 1) {
        // Recursively flatten arrays (susceptible to call stack limits).
        baseFlatten(value, depth - 1, predicate, isStrict, result);
      } else {
        arrayPush(result, value);
      }
    } else if (!isStrict) {
      result[result.length] = value;
    }
  }
  return result;
}

module.exports = baseFlatten;

},{"./_arrayPush":110,"./_isFlattenable":140}],120:[function(require,module,exports){
arguments[4][42][0].apply(exports,arguments)
},{"./_indexOfNaN":139,"dup":42}],121:[function(require,module,exports){
var Reflect = require('./_Reflect'),
    iteratorToArray = require('./_iteratorToArray');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Built-in value references. */
var enumerate = Reflect ? Reflect.enumerate : undefined,
    propertyIsEnumerable = objectProto.propertyIsEnumerable;

/**
 * The base implementation of `_.keysIn` which doesn't skip the constructor
 * property of prototypes or treat sparse arrays as dense.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 */
function baseKeysIn(object) {
  object = object == null ? object : Object(object);

  var result = [];
  for (var key in object) {
    result.push(key);
  }
  return result;
}

// Fallback for IE < 9 with es6-shim.
if (enumerate && !propertyIsEnumerable.call({ 'valueOf': 1 }, 'valueOf')) {
  baseKeysIn = function(object) {
    return iteratorToArray(enumerate(object));
  };
}

module.exports = baseKeysIn;

},{"./_Reflect":103,"./_iteratorToArray":146}],122:[function(require,module,exports){
arguments[4][44][0].apply(exports,arguments)
},{"dup":44}],123:[function(require,module,exports){
/**
 * The base implementation of `_.times` without support for iteratee shorthands
 * or max array length checks.
 *
 * @private
 * @param {number} n The number of times to invoke `iteratee`.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns the array of results.
 */
function baseTimes(n, iteratee) {
  var index = -1,
      result = Array(n);

  while (++index < n) {
    result[index] = iteratee(index);
  }
  return result;
}

module.exports = baseTimes;

},{}],124:[function(require,module,exports){
arguments[4][45][0].apply(exports,arguments)
},{"dup":45}],125:[function(require,module,exports){
arguments[4][46][0].apply(exports,arguments)
},{"./_SetCache":105,"./_arrayIncludes":107,"./_arrayIncludesWith":108,"./_cacheHas":126,"./_createSet":131,"./_setToArray":154,"dup":46}],126:[function(require,module,exports){
arguments[4][48][0].apply(exports,arguments)
},{"./_isKeyable":144,"dup":48}],127:[function(require,module,exports){
arguments[4][49][0].apply(exports,arguments)
},{"./_isKeyable":144,"dup":49}],128:[function(require,module,exports){
arguments[4][51][0].apply(exports,arguments)
},{"dup":51}],129:[function(require,module,exports){
var assignValue = require('./_assignValue');

/**
 * Copies properties of `source` to `object`.
 *
 * @private
 * @param {Object} source The object to copy properties from.
 * @param {Array} props The property identifiers to copy.
 * @param {Object} [object={}] The object to copy properties to.
 * @param {Function} [customizer] The function to customize copied values.
 * @returns {Object} Returns `object`.
 */
function copyObject(source, props, object, customizer) {
  object || (object = {});

  var index = -1,
      length = props.length;

  while (++index < length) {
    var key = props[index];

    var newValue = customizer
      ? customizer(object[key], source[key], key, object, source)
      : source[key];

    assignValue(object, key, newValue);
  }
  return object;
}

module.exports = copyObject;

},{"./_assignValue":112}],130:[function(require,module,exports){
var isIterateeCall = require('./_isIterateeCall'),
    rest = require('./rest');

/**
 * Creates a function like `_.assign`.
 *
 * @private
 * @param {Function} assigner The function to assign values.
 * @returns {Function} Returns the new assigner function.
 */
function createAssigner(assigner) {
  return rest(function(object, sources) {
    var index = -1,
        length = sources.length,
        customizer = length > 1 ? sources[length - 1] : undefined,
        guard = length > 2 ? sources[2] : undefined;

    customizer = typeof customizer == 'function'
      ? (length--, customizer)
      : undefined;

    if (guard && isIterateeCall(sources[0], sources[1], guard)) {
      customizer = length < 3 ? undefined : customizer;
      length = 1;
    }
    object = Object(object);
    while (++index < length) {
      var source = sources[index];
      if (source) {
        assigner(object, source, index, customizer);
      }
    }
    return object;
  });
}

module.exports = createAssigner;

},{"./_isIterateeCall":143,"./rest":173}],131:[function(require,module,exports){
arguments[4][52][0].apply(exports,arguments)
},{"./_Set":104,"./noop":172,"dup":52}],132:[function(require,module,exports){
arguments[4][53][0].apply(exports,arguments)
},{"./_baseProperty":122,"dup":53}],133:[function(require,module,exports){
arguments[4][54][0].apply(exports,arguments)
},{"./isNative":165,"dup":54}],134:[function(require,module,exports){
arguments[4][55][0].apply(exports,arguments)
},{"./_hashHas":136,"dup":55}],135:[function(require,module,exports){
arguments[4][56][0].apply(exports,arguments)
},{"./_nativeCreate":152,"dup":56}],136:[function(require,module,exports){
arguments[4][57][0].apply(exports,arguments)
},{"./_nativeCreate":152,"dup":57}],137:[function(require,module,exports){
arguments[4][58][0].apply(exports,arguments)
},{"./_nativeCreate":152,"dup":58}],138:[function(require,module,exports){
var baseTimes = require('./_baseTimes'),
    isArguments = require('./isArguments'),
    isArray = require('./isArray'),
    isLength = require('./isLength'),
    isString = require('./isString');

/**
 * Creates an array of index keys for `object` values of arrays,
 * `arguments` objects, and strings, otherwise `null` is returned.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array|null} Returns index keys, else `null`.
 */
function indexKeys(object) {
  var length = object ? object.length : undefined;
  if (isLength(length) &&
      (isArray(object) || isString(object) || isArguments(object))) {
    return baseTimes(length, String);
  }
  return null;
}

module.exports = indexKeys;

},{"./_baseTimes":123,"./isArguments":159,"./isArray":160,"./isLength":164,"./isString":168}],139:[function(require,module,exports){
arguments[4][59][0].apply(exports,arguments)
},{"dup":59}],140:[function(require,module,exports){
var isArguments = require('./isArguments'),
    isArray = require('./isArray'),
    isArrayLikeObject = require('./isArrayLikeObject');

/**
 * Checks if `value` is a flattenable `arguments` object or array.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is flattenable, else `false`.
 */
function isFlattenable(value) {
  return isArrayLikeObject(value) && (isArray(value) || isArguments(value));
}

module.exports = isFlattenable;

},{"./isArguments":159,"./isArray":160,"./isArrayLikeObject":162}],141:[function(require,module,exports){
arguments[4][60][0].apply(exports,arguments)
},{"dup":60}],142:[function(require,module,exports){
/** Used as references for various `Number` constants. */
var MAX_SAFE_INTEGER = 9007199254740991;

/** Used to detect unsigned integer values. */
var reIsUint = /^(?:0|[1-9]\d*)$/;

/**
 * Checks if `value` is a valid array-like index.
 *
 * @private
 * @param {*} value The value to check.
 * @param {number} [length=MAX_SAFE_INTEGER] The upper bounds of a valid index.
 * @returns {boolean} Returns `true` if `value` is a valid index, else `false`.
 */
function isIndex(value, length) {
  value = (typeof value == 'number' || reIsUint.test(value)) ? +value : -1;
  length = length == null ? MAX_SAFE_INTEGER : length;
  return value > -1 && value % 1 == 0 && value < length;
}

module.exports = isIndex;

},{}],143:[function(require,module,exports){
var eq = require('./eq'),
    isArrayLike = require('./isArrayLike'),
    isIndex = require('./_isIndex'),
    isObject = require('./isObject');

/**
 * Checks if the given arguments are from an iteratee call.
 *
 * @private
 * @param {*} value The potential iteratee value argument.
 * @param {*} index The potential iteratee index or key argument.
 * @param {*} object The potential iteratee object argument.
 * @returns {boolean} Returns `true` if the arguments are from an iteratee call,
 *  else `false`.
 */
function isIterateeCall(value, index, object) {
  if (!isObject(object)) {
    return false;
  }
  var type = typeof index;
  if (type == 'number'
        ? (isArrayLike(object) && isIndex(index, object.length))
        : (type == 'string' && index in object)
      ) {
    return eq(object[index], value);
  }
  return false;
}

module.exports = isIterateeCall;

},{"./_isIndex":142,"./eq":158,"./isArrayLike":161,"./isObject":166}],144:[function(require,module,exports){
arguments[4][61][0].apply(exports,arguments)
},{"dup":61}],145:[function(require,module,exports){
/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Checks if `value` is likely a prototype object.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a prototype, else `false`.
 */
function isPrototype(value) {
  var Ctor = value && value.constructor,
      proto = (typeof Ctor == 'function' && Ctor.prototype) || objectProto;

  return value === proto;
}

module.exports = isPrototype;

},{}],146:[function(require,module,exports){
/**
 * Converts `iterator` to an array.
 *
 * @private
 * @param {Object} iterator The iterator to convert.
 * @returns {Array} Returns the converted array.
 */
function iteratorToArray(iterator) {
  var data,
      result = [];

  while (!(data = iterator.next()).done) {
    result.push(data.value);
  }
  return result;
}

module.exports = iteratorToArray;

},{}],147:[function(require,module,exports){
arguments[4][62][0].apply(exports,arguments)
},{"./_Hash":100,"./_Map":101,"dup":62}],148:[function(require,module,exports){
arguments[4][63][0].apply(exports,arguments)
},{"./_Map":101,"./_assocDelete":113,"./_hashDelete":134,"./_isKeyable":144,"dup":63}],149:[function(require,module,exports){
arguments[4][64][0].apply(exports,arguments)
},{"./_Map":101,"./_assocGet":114,"./_hashGet":135,"./_isKeyable":144,"dup":64}],150:[function(require,module,exports){
arguments[4][65][0].apply(exports,arguments)
},{"./_Map":101,"./_assocHas":115,"./_hashHas":136,"./_isKeyable":144,"dup":65}],151:[function(require,module,exports){
arguments[4][66][0].apply(exports,arguments)
},{"./_Map":101,"./_assocSet":117,"./_hashSet":137,"./_isKeyable":144,"dup":66}],152:[function(require,module,exports){
arguments[4][67][0].apply(exports,arguments)
},{"./_getNative":133,"dup":67}],153:[function(require,module,exports){
(function (global){
var checkGlobal = require('./_checkGlobal');

/** Used to determine if values are of the language type `Object`. */
var objectTypes = {
  'function': true,
  'object': true
};

/** Detect free variable `exports`. */
var freeExports = (objectTypes[typeof exports] && exports && !exports.nodeType)
  ? exports
  : undefined;

/** Detect free variable `module`. */
var freeModule = (objectTypes[typeof module] && module && !module.nodeType)
  ? module
  : undefined;

/** Detect free variable `global` from Node.js. */
var freeGlobal = checkGlobal(freeExports && freeModule && typeof global == 'object' && global);

/** Detect free variable `self`. */
var freeSelf = checkGlobal(objectTypes[typeof self] && self);

/** Detect free variable `window`. */
var freeWindow = checkGlobal(objectTypes[typeof window] && window);

/** Detect `this` as the global object. */
var thisGlobal = checkGlobal(objectTypes[typeof this] && this);

/**
 * Used as a reference to the global object.
 *
 * The `this` value is used if it's the global object to avoid Greasemonkey's
 * restricted `window` object, otherwise the `window` object is used.
 */
var root = freeGlobal ||
  ((freeWindow !== (thisGlobal && thisGlobal.window)) && freeWindow) ||
    freeSelf || thisGlobal || Function('return this')();

module.exports = root;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./_checkGlobal":128}],154:[function(require,module,exports){
arguments[4][69][0].apply(exports,arguments)
},{"dup":69}],155:[function(require,module,exports){
arguments[4][70][0].apply(exports,arguments)
},{"dup":70}],156:[function(require,module,exports){
var copyObject = require('./_copyObject'),
    createAssigner = require('./_createAssigner'),
    keysIn = require('./keysIn');

/**
 * This method is like `_.assignIn` except that it accepts `customizer`
 * which is invoked to produce the assigned values. If `customizer` returns
 * `undefined`, assignment is handled by the method instead. The `customizer`
 * is invoked with five arguments: (objValue, srcValue, key, object, source).
 *
 * **Note:** This method mutates `object`.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @alias extendWith
 * @category Object
 * @param {Object} object The destination object.
 * @param {...Object} sources The source objects.
 * @param {Function} [customizer] The function to customize assigned values.
 * @returns {Object} Returns `object`.
 * @example
 *
 * function customizer(objValue, srcValue) {
 *   return _.isUndefined(objValue) ? srcValue : objValue;
 * }
 *
 * var defaults = _.partialRight(_.assignInWith, customizer);
 *
 * defaults({ 'a': 1 }, { 'b': 2 }, { 'a': 3 });
 * // => { 'a': 1, 'b': 2 }
 */
var assignInWith = createAssigner(function(object, source, srcIndex, customizer) {
  copyObject(source, keysIn(source), object, customizer);
});

module.exports = assignInWith;

},{"./_copyObject":129,"./_createAssigner":130,"./keysIn":170}],157:[function(require,module,exports){
var apply = require('./_apply'),
    assignInDefaults = require('./_assignInDefaults'),
    assignInWith = require('./assignInWith'),
    rest = require('./rest');

/**
 * Assigns own and inherited enumerable string keyed properties of source
 * objects to the destination object for all destination properties that
 * resolve to `undefined`. Source objects are applied from left to right.
 * Once a property is set, additional values of the same property are ignored.
 *
 * **Note:** This method mutates `object`.
 *
 * @static
 * @since 0.1.0
 * @memberOf _
 * @category Object
 * @param {Object} object The destination object.
 * @param {...Object} [sources] The source objects.
 * @returns {Object} Returns `object`.
 * @example
 *
 * _.defaults({ 'user': 'barney' }, { 'age': 36 }, { 'user': 'fred' });
 * // => { 'user': 'barney', 'age': 36 }
 */
var defaults = rest(function(args) {
  args.push(undefined, assignInDefaults);
  return apply(assignInWith, undefined, args);
});

module.exports = defaults;

},{"./_apply":106,"./_assignInDefaults":111,"./assignInWith":156,"./rest":173}],158:[function(require,module,exports){
arguments[4][71][0].apply(exports,arguments)
},{"dup":71}],159:[function(require,module,exports){
var isArrayLikeObject = require('./isArrayLikeObject');

/** `Object#toString` result references. */
var argsTag = '[object Arguments]';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/** Built-in value references. */
var propertyIsEnumerable = objectProto.propertyIsEnumerable;

/**
 * Checks if `value` is likely an `arguments` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is correctly classified,
 *  else `false`.
 * @example
 *
 * _.isArguments(function() { return arguments; }());
 * // => true
 *
 * _.isArguments([1, 2, 3]);
 * // => false
 */
function isArguments(value) {
  // Safari 8.1 incorrectly makes `arguments.callee` enumerable in strict mode.
  return isArrayLikeObject(value) && hasOwnProperty.call(value, 'callee') &&
    (!propertyIsEnumerable.call(value, 'callee') || objectToString.call(value) == argsTag);
}

module.exports = isArguments;

},{"./isArrayLikeObject":162}],160:[function(require,module,exports){
arguments[4][73][0].apply(exports,arguments)
},{"dup":73}],161:[function(require,module,exports){
arguments[4][74][0].apply(exports,arguments)
},{"./_getLength":132,"./isFunction":163,"./isLength":164,"dup":74}],162:[function(require,module,exports){
arguments[4][75][0].apply(exports,arguments)
},{"./isArrayLike":161,"./isObjectLike":167,"dup":75}],163:[function(require,module,exports){
arguments[4][76][0].apply(exports,arguments)
},{"./isObject":166,"dup":76}],164:[function(require,module,exports){
arguments[4][77][0].apply(exports,arguments)
},{"dup":77}],165:[function(require,module,exports){
arguments[4][78][0].apply(exports,arguments)
},{"./_isHostObject":141,"./_toSource":155,"./isFunction":163,"./isObject":166,"dup":78}],166:[function(require,module,exports){
arguments[4][79][0].apply(exports,arguments)
},{"dup":79}],167:[function(require,module,exports){
arguments[4][80][0].apply(exports,arguments)
},{"dup":80}],168:[function(require,module,exports){
var isArray = require('./isArray'),
    isObjectLike = require('./isObjectLike');

/** `Object#toString` result references. */
var stringTag = '[object String]';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/**
 * Checks if `value` is classified as a `String` primitive or object.
 *
 * @static
 * @since 0.1.0
 * @memberOf _
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is correctly classified,
 *  else `false`.
 * @example
 *
 * _.isString('abc');
 * // => true
 *
 * _.isString(1);
 * // => false
 */
function isString(value) {
  return typeof value == 'string' ||
    (!isArray(value) && isObjectLike(value) && objectToString.call(value) == stringTag);
}

module.exports = isString;

},{"./isArray":160,"./isObjectLike":167}],169:[function(require,module,exports){
arguments[4][81][0].apply(exports,arguments)
},{"./isObjectLike":167,"dup":81}],170:[function(require,module,exports){
var baseKeysIn = require('./_baseKeysIn'),
    indexKeys = require('./_indexKeys'),
    isIndex = require('./_isIndex'),
    isPrototype = require('./_isPrototype');

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Creates an array of the own and inherited enumerable property names of `object`.
 *
 * **Note:** Non-object values are coerced to objects.
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category Object
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 * @example
 *
 * function Foo() {
 *   this.a = 1;
 *   this.b = 2;
 * }
 *
 * Foo.prototype.c = 3;
 *
 * _.keysIn(new Foo);
 * // => ['a', 'b', 'c'] (iteration order is not guaranteed)
 */
function keysIn(object) {
  var index = -1,
      isProto = isPrototype(object),
      props = baseKeysIn(object),
      propsLength = props.length,
      indexes = indexKeys(object),
      skipIndexes = !!indexes,
      result = indexes || [],
      length = result.length;

  while (++index < propsLength) {
    var key = props[index];
    if (!(skipIndexes && (key == 'length' || isIndex(key, length))) &&
        !(key == 'constructor' && (isProto || !hasOwnProperty.call(object, key)))) {
      result.push(key);
    }
  }
  return result;
}

module.exports = keysIn;

},{"./_baseKeysIn":121,"./_indexKeys":138,"./_isIndex":142,"./_isPrototype":145}],171:[function(require,module,exports){
var MapCache = require('./_MapCache');

/** Used as the `TypeError` message for "Functions" methods. */
var FUNC_ERROR_TEXT = 'Expected a function';

/**
 * Creates a function that memoizes the result of `func`. If `resolver` is
 * provided, it determines the cache key for storing the result based on the
 * arguments provided to the memoized function. By default, the first argument
 * provided to the memoized function is used as the map cache key. The `func`
 * is invoked with the `this` binding of the memoized function.
 *
 * **Note:** The cache is exposed as the `cache` property on the memoized
 * function. Its creation may be customized by replacing the `_.memoize.Cache`
 * constructor with one whose instances implement the
 * [`Map`](http://ecma-international.org/ecma-262/6.0/#sec-properties-of-the-map-prototype-object)
 * method interface of `delete`, `get`, `has`, and `set`.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Function
 * @param {Function} func The function to have its output memoized.
 * @param {Function} [resolver] The function to resolve the cache key.
 * @returns {Function} Returns the new memoizing function.
 * @example
 *
 * var object = { 'a': 1, 'b': 2 };
 * var other = { 'c': 3, 'd': 4 };
 *
 * var values = _.memoize(_.values);
 * values(object);
 * // => [1, 2]
 *
 * values(other);
 * // => [3, 4]
 *
 * object.a = 2;
 * values(object);
 * // => [1, 2]
 *
 * // Modify the result cache.
 * values.cache.set(object, ['a', 'b']);
 * values(object);
 * // => ['a', 'b']
 *
 * // Replace `_.memoize.Cache`.
 * _.memoize.Cache = WeakMap;
 */
function memoize(func, resolver) {
  if (typeof func != 'function' || (resolver && typeof resolver != 'function')) {
    throw new TypeError(FUNC_ERROR_TEXT);
  }
  var memoized = function() {
    var args = arguments,
        key = resolver ? resolver.apply(this, args) : args[0],
        cache = memoized.cache;

    if (cache.has(key)) {
      return cache.get(key);
    }
    var result = func.apply(this, args);
    memoized.cache = cache.set(key, result);
    return result;
  };
  memoized.cache = new (memoize.Cache || MapCache);
  return memoized;
}

// Assign cache to `_.memoize`.
memoize.Cache = MapCache;

module.exports = memoize;

},{"./_MapCache":102}],172:[function(require,module,exports){
arguments[4][82][0].apply(exports,arguments)
},{"dup":82}],173:[function(require,module,exports){
arguments[4][83][0].apply(exports,arguments)
},{"./_apply":106,"./toInteger":174,"dup":83}],174:[function(require,module,exports){
arguments[4][84][0].apply(exports,arguments)
},{"./toNumber":175,"dup":84}],175:[function(require,module,exports){
arguments[4][85][0].apply(exports,arguments)
},{"./isFunction":163,"./isObject":166,"./isSymbol":169,"dup":85}],176:[function(require,module,exports){
var baseFlatten = require('./_baseFlatten'),
    baseUniq = require('./_baseUniq'),
    isArrayLikeObject = require('./isArrayLikeObject'),
    rest = require('./rest');

/**
 * Creates an array of unique values, in order, from all given arrays using
 * [`SameValueZero`](http://ecma-international.org/ecma-262/6.0/#sec-samevaluezero)
 * for equality comparisons.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Array
 * @param {...Array} [arrays] The arrays to inspect.
 * @returns {Array} Returns the new array of combined values.
 * @example
 *
 * _.union([2, 1], [4, 2], [1, 2]);
 * // => [2, 1, 4]
 */
var union = rest(function(arrays) {
  return baseUniq(baseFlatten(arrays, 1, isArrayLikeObject, true));
});

module.exports = union;

},{"./_baseFlatten":119,"./_baseUniq":125,"./isArrayLikeObject":162,"./rest":173}],177:[function(require,module,exports){
arguments[4][86][0].apply(exports,arguments)
},{"./_baseDifference":118,"./isArrayLikeObject":162,"./rest":173,"dup":86}],178:[function(require,module,exports){
'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _slice = Array.prototype.slice;

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

exports['default'] = DragDropContext;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _dndCore = require('dnd-core');

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _utilsCheckDecoratorArguments = require('./utils/checkDecoratorArguments');

var _utilsCheckDecoratorArguments2 = _interopRequireDefault(_utilsCheckDecoratorArguments);

function DragDropContext(backendOrModule) {
  _utilsCheckDecoratorArguments2['default'].apply(undefined, ['DragDropContext', 'backend'].concat(_slice.call(arguments)));

  // Auto-detect ES6 default export for people still using ES5
  var backend = undefined;
  if (typeof backendOrModule === 'object' && typeof backendOrModule['default'] === 'function') {
    backend = backendOrModule['default'];
  } else {
    backend = backendOrModule;
  }

  _invariant2['default'](typeof backend === 'function', 'Expected the backend to be a function or an ES6 module exporting a default function. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-drop-context.html');

  var childContext = {
    dragDropManager: new _dndCore.DragDropManager(backend)
  };

  return function decorateContext(DecoratedComponent) {
    var displayName = DecoratedComponent.displayName || DecoratedComponent.name || 'Component';

    return (function (_Component) {
      _inherits(DragDropContextContainer, _Component);

      function DragDropContextContainer() {
        _classCallCheck(this, DragDropContextContainer);

        _Component.apply(this, arguments);
      }

      DragDropContextContainer.prototype.getDecoratedComponentInstance = function getDecoratedComponentInstance() {
        return this.refs.child;
      };

      DragDropContextContainer.prototype.getManager = function getManager() {
        return childContext.dragDropManager;
      };

      DragDropContextContainer.prototype.getChildContext = function getChildContext() {
        return childContext;
      };

      DragDropContextContainer.prototype.render = function render() {
        return _react2['default'].createElement(DecoratedComponent, _extends({}, this.props, {
          ref: 'child' }));
      };

      _createClass(DragDropContextContainer, null, [{
        key: 'DecoratedComponent',
        value: DecoratedComponent,
        enumerable: true
      }, {
        key: 'displayName',
        value: 'DragDropContext(' + displayName + ')',
        enumerable: true
      }, {
        key: 'childContextTypes',
        value: {
          dragDropManager: _react.PropTypes.object.isRequired
        },
        enumerable: true
      }]);

      return DragDropContextContainer;
    })(_react.Component);
  };
}

module.exports = exports['default'];
},{"./utils/checkDecoratorArguments":193,"dnd-core":16,"invariant":88,"react":undefined}],179:[function(require,module,exports){
'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _slice = Array.prototype.slice;

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

exports['default'] = DragLayer;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _utilsShallowEqual = require('./utils/shallowEqual');

var _utilsShallowEqual2 = _interopRequireDefault(_utilsShallowEqual);

var _utilsShallowEqualScalar = require('./utils/shallowEqualScalar');

var _utilsShallowEqualScalar2 = _interopRequireDefault(_utilsShallowEqualScalar);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _utilsCheckDecoratorArguments = require('./utils/checkDecoratorArguments');

var _utilsCheckDecoratorArguments2 = _interopRequireDefault(_utilsCheckDecoratorArguments);

function DragLayer(collect) {
  var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  _utilsCheckDecoratorArguments2['default'].apply(undefined, ['DragLayer', 'collect[, options]'].concat(_slice.call(arguments)));
  _invariant2['default'](typeof collect === 'function', 'Expected "collect" provided as the first argument to DragLayer ' + 'to be a function that collects props to inject into the component. ', 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-layer.html', collect);
  _invariant2['default'](_lodashIsPlainObject2['default'](options), 'Expected "options" provided as the second argument to DragLayer to be ' + 'a plain object when specified. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-layer.html', options);

  return function decorateLayer(DecoratedComponent) {
    var _options$arePropsEqual = options.arePropsEqual;
    var arePropsEqual = _options$arePropsEqual === undefined ? _utilsShallowEqualScalar2['default'] : _options$arePropsEqual;

    var displayName = DecoratedComponent.displayName || DecoratedComponent.name || 'Component';

    return (function (_Component) {
      _inherits(DragLayerContainer, _Component);

      DragLayerContainer.prototype.getDecoratedComponentInstance = function getDecoratedComponentInstance() {
        return this.refs.child;
      };

      DragLayerContainer.prototype.shouldComponentUpdate = function shouldComponentUpdate(nextProps, nextState) {
        return !arePropsEqual(nextProps, this.props) || !_utilsShallowEqual2['default'](nextState, this.state);
      };

      _createClass(DragLayerContainer, null, [{
        key: 'DecoratedComponent',
        value: DecoratedComponent,
        enumerable: true
      }, {
        key: 'displayName',
        value: 'DragLayer(' + displayName + ')',
        enumerable: true
      }, {
        key: 'contextTypes',
        value: {
          dragDropManager: _react.PropTypes.object.isRequired
        },
        enumerable: true
      }]);

      function DragLayerContainer(props, context) {
        _classCallCheck(this, DragLayerContainer);

        _Component.call(this, props);
        this.handleChange = this.handleChange.bind(this);

        this.manager = context.dragDropManager;
        _invariant2['default'](typeof this.manager === 'object', 'Could not find the drag and drop manager in the context of %s. ' + 'Make sure to wrap the top-level component of your app with DragDropContext. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-troubleshooting.html#could-not-find-the-drag-and-drop-manager-in-the-context', displayName, displayName);

        this.state = this.getCurrentState();
      }

      DragLayerContainer.prototype.componentDidMount = function componentDidMount() {
        this.isCurrentlyMounted = true;

        var monitor = this.manager.getMonitor();
        this.unsubscribeFromOffsetChange = monitor.subscribeToOffsetChange(this.handleChange);
        this.unsubscribeFromStateChange = monitor.subscribeToStateChange(this.handleChange);

        this.handleChange();
      };

      DragLayerContainer.prototype.componentWillUnmount = function componentWillUnmount() {
        this.isCurrentlyMounted = false;

        this.unsubscribeFromOffsetChange();
        this.unsubscribeFromStateChange();
      };

      DragLayerContainer.prototype.handleChange = function handleChange() {
        if (!this.isCurrentlyMounted) {
          return;
        }

        var nextState = this.getCurrentState();
        if (!_utilsShallowEqual2['default'](nextState, this.state)) {
          this.setState(nextState);
        }
      };

      DragLayerContainer.prototype.getCurrentState = function getCurrentState() {
        var monitor = this.manager.getMonitor();
        return collect(monitor);
      };

      DragLayerContainer.prototype.render = function render() {
        return _react2['default'].createElement(DecoratedComponent, _extends({}, this.props, this.state, {
          ref: 'child' }));
      };

      return DragLayerContainer;
    })(_react.Component);
  };
}

module.exports = exports['default'];
},{"./utils/checkDecoratorArguments":193,"./utils/shallowEqual":196,"./utils/shallowEqualScalar":197,"invariant":88,"lodash/isPlainObject":203,"react":undefined}],180:[function(require,module,exports){
'use strict';

exports.__esModule = true;
var _slice = Array.prototype.slice;
exports['default'] = DragSource;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var _utilsCheckDecoratorArguments = require('./utils/checkDecoratorArguments');

var _utilsCheckDecoratorArguments2 = _interopRequireDefault(_utilsCheckDecoratorArguments);

var _decorateHandler = require('./decorateHandler');

var _decorateHandler2 = _interopRequireDefault(_decorateHandler);

var _registerSource = require('./registerSource');

var _registerSource2 = _interopRequireDefault(_registerSource);

var _createSourceFactory = require('./createSourceFactory');

var _createSourceFactory2 = _interopRequireDefault(_createSourceFactory);

var _createSourceMonitor = require('./createSourceMonitor');

var _createSourceMonitor2 = _interopRequireDefault(_createSourceMonitor);

var _createSourceConnector = require('./createSourceConnector');

var _createSourceConnector2 = _interopRequireDefault(_createSourceConnector);

var _utilsIsValidType = require('./utils/isValidType');

var _utilsIsValidType2 = _interopRequireDefault(_utilsIsValidType);

function DragSource(type, spec, collect) {
  var options = arguments.length <= 3 || arguments[3] === undefined ? {} : arguments[3];

  _utilsCheckDecoratorArguments2['default'].apply(undefined, ['DragSource', 'type, spec, collect[, options]'].concat(_slice.call(arguments)));
  var getType = type;
  if (typeof type !== 'function') {
    _invariant2['default'](_utilsIsValidType2['default'](type), 'Expected "type" provided as the first argument to DragSource to be ' + 'a string, or a function that returns a string given the current props. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', type);
    getType = function () {
      return type;
    };
  }
  _invariant2['default'](_lodashIsPlainObject2['default'](spec), 'Expected "spec" provided as the second argument to DragSource to be ' + 'a plain object. Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', spec);
  var createSource = _createSourceFactory2['default'](spec);
  _invariant2['default'](typeof collect === 'function', 'Expected "collect" provided as the third argument to DragSource to be ' + 'a function that returns a plain object of props to inject. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', collect);
  _invariant2['default'](_lodashIsPlainObject2['default'](options), 'Expected "options" provided as the fourth argument to DragSource to be ' + 'a plain object when specified. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', collect);

  return function decorateSource(DecoratedComponent) {
    return _decorateHandler2['default']({
      connectBackend: function connectBackend(backend, sourceId) {
        return backend.connectDragSource(sourceId);
      },
      containerDisplayName: 'DragSource',
      createHandler: createSource,
      registerHandler: _registerSource2['default'],
      createMonitor: _createSourceMonitor2['default'],
      createConnector: _createSourceConnector2['default'],
      DecoratedComponent: DecoratedComponent,
      getType: getType,
      collect: collect,
      options: options
    });
  };
}

module.exports = exports['default'];
},{"./createSourceConnector":183,"./createSourceFactory":184,"./createSourceMonitor":185,"./decorateHandler":189,"./registerSource":191,"./utils/checkDecoratorArguments":193,"./utils/isValidType":195,"invariant":88,"lodash/isPlainObject":203}],181:[function(require,module,exports){
'use strict';

exports.__esModule = true;
var _slice = Array.prototype.slice;
exports['default'] = DropTarget;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var _utilsCheckDecoratorArguments = require('./utils/checkDecoratorArguments');

var _utilsCheckDecoratorArguments2 = _interopRequireDefault(_utilsCheckDecoratorArguments);

var _decorateHandler = require('./decorateHandler');

var _decorateHandler2 = _interopRequireDefault(_decorateHandler);

var _registerTarget = require('./registerTarget');

var _registerTarget2 = _interopRequireDefault(_registerTarget);

var _createTargetFactory = require('./createTargetFactory');

var _createTargetFactory2 = _interopRequireDefault(_createTargetFactory);

var _createTargetMonitor = require('./createTargetMonitor');

var _createTargetMonitor2 = _interopRequireDefault(_createTargetMonitor);

var _createTargetConnector = require('./createTargetConnector');

var _createTargetConnector2 = _interopRequireDefault(_createTargetConnector);

var _utilsIsValidType = require('./utils/isValidType');

var _utilsIsValidType2 = _interopRequireDefault(_utilsIsValidType);

function DropTarget(type, spec, collect) {
  var options = arguments.length <= 3 || arguments[3] === undefined ? {} : arguments[3];

  _utilsCheckDecoratorArguments2['default'].apply(undefined, ['DropTarget', 'type, spec, collect[, options]'].concat(_slice.call(arguments)));
  var getType = type;
  if (typeof type !== 'function') {
    _invariant2['default'](_utilsIsValidType2['default'](type, true), 'Expected "type" provided as the first argument to DropTarget to be ' + 'a string, an array of strings, or a function that returns either given ' + 'the current props. Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', type);
    getType = function () {
      return type;
    };
  }
  _invariant2['default'](_lodashIsPlainObject2['default'](spec), 'Expected "spec" provided as the second argument to DropTarget to be ' + 'a plain object. Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', spec);
  var createTarget = _createTargetFactory2['default'](spec);
  _invariant2['default'](typeof collect === 'function', 'Expected "collect" provided as the third argument to DropTarget to be ' + 'a function that returns a plain object of props to inject. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', collect);
  _invariant2['default'](_lodashIsPlainObject2['default'](options), 'Expected "options" provided as the fourth argument to DropTarget to be ' + 'a plain object when specified. ' + 'Instead, received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', collect);

  return function decorateTarget(DecoratedComponent) {
    return _decorateHandler2['default']({
      connectBackend: function connectBackend(backend, targetId) {
        return backend.connectDropTarget(targetId);
      },
      containerDisplayName: 'DropTarget',
      createHandler: createTarget,
      registerHandler: _registerTarget2['default'],
      createMonitor: _createTargetMonitor2['default'],
      createConnector: _createTargetConnector2['default'],
      DecoratedComponent: DecoratedComponent,
      getType: getType,
      collect: collect,
      options: options
    });
  };
}

module.exports = exports['default'];
},{"./createTargetConnector":186,"./createTargetFactory":187,"./createTargetMonitor":188,"./decorateHandler":189,"./registerTarget":192,"./utils/checkDecoratorArguments":193,"./utils/isValidType":195,"invariant":88,"lodash/isPlainObject":203}],182:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = areOptionsEqual;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _utilsShallowEqual = require('./utils/shallowEqual');

var _utilsShallowEqual2 = _interopRequireDefault(_utilsShallowEqual);

function areOptionsEqual(nextOptions, currentOptions) {
  if (currentOptions === nextOptions) {
    return true;
  }

  return currentOptions !== null && nextOptions !== null && _utilsShallowEqual2['default'](currentOptions, nextOptions);
}

module.exports = exports['default'];
},{"./utils/shallowEqual":196}],183:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createSourceConnector;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _wrapConnectorHooks = require('./wrapConnectorHooks');

var _wrapConnectorHooks2 = _interopRequireDefault(_wrapConnectorHooks);

var _areOptionsEqual = require('./areOptionsEqual');

var _areOptionsEqual2 = _interopRequireDefault(_areOptionsEqual);

function createSourceConnector(backend) {
  var currentHandlerId = undefined;

  var currentDragSourceNode = undefined;
  var currentDragSourceOptions = undefined;
  var disconnectCurrentDragSource = undefined;

  var currentDragPreviewNode = undefined;
  var currentDragPreviewOptions = undefined;
  var disconnectCurrentDragPreview = undefined;

  function reconnectDragSource() {
    if (disconnectCurrentDragSource) {
      disconnectCurrentDragSource();
      disconnectCurrentDragSource = null;
    }

    if (currentHandlerId && currentDragSourceNode) {
      disconnectCurrentDragSource = backend.connectDragSource(currentHandlerId, currentDragSourceNode, currentDragSourceOptions);
    }
  }

  function reconnectDragPreview() {
    if (disconnectCurrentDragPreview) {
      disconnectCurrentDragPreview();
      disconnectCurrentDragPreview = null;
    }

    if (currentHandlerId && currentDragPreviewNode) {
      disconnectCurrentDragPreview = backend.connectDragPreview(currentHandlerId, currentDragPreviewNode, currentDragPreviewOptions);
    }
  }

  function receiveHandlerId(handlerId) {
    if (handlerId === currentHandlerId) {
      return;
    }

    currentHandlerId = handlerId;
    reconnectDragSource();
    reconnectDragPreview();
  }

  var hooks = _wrapConnectorHooks2['default']({
    dragSource: function connectDragSource(node, options) {
      if (node === currentDragSourceNode && _areOptionsEqual2['default'](options, currentDragSourceOptions)) {
        return;
      }

      currentDragSourceNode = node;
      currentDragSourceOptions = options;

      reconnectDragSource();
    },

    dragPreview: function connectDragPreview(node, options) {
      if (node === currentDragPreviewNode && _areOptionsEqual2['default'](options, currentDragPreviewOptions)) {
        return;
      }

      currentDragPreviewNode = node;
      currentDragPreviewOptions = options;

      reconnectDragPreview();
    }
  });

  return {
    receiveHandlerId: receiveHandlerId,
    hooks: hooks
  };
}

module.exports = exports['default'];
},{"./areOptionsEqual":182,"./wrapConnectorHooks":198}],184:[function(require,module,exports){
(function (process){
'use strict';

exports.__esModule = true;
exports['default'] = createSourceFactory;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var ALLOWED_SPEC_METHODS = ['canDrag', 'beginDrag', 'canDrag', 'isDragging', 'endDrag'];
var REQUIRED_SPEC_METHODS = ['beginDrag'];

function createSourceFactory(spec) {
  Object.keys(spec).forEach(function (key) {
    _invariant2['default'](ALLOWED_SPEC_METHODS.indexOf(key) > -1, 'Expected the drag source specification to only have ' + 'some of the following keys: %s. ' + 'Instead received a specification with an unexpected "%s" key. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', ALLOWED_SPEC_METHODS.join(', '), key);
    _invariant2['default'](typeof spec[key] === 'function', 'Expected %s in the drag source specification to be a function. ' + 'Instead received a specification with %s: %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', key, key, spec[key]);
  });
  REQUIRED_SPEC_METHODS.forEach(function (key) {
    _invariant2['default'](typeof spec[key] === 'function', 'Expected %s in the drag source specification to be a function. ' + 'Instead received a specification with %s: %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', key, key, spec[key]);
  });

  var Source = (function () {
    function Source(monitor) {
      _classCallCheck(this, Source);

      this.monitor = monitor;
      this.props = null;
      this.component = null;
    }

    Source.prototype.receiveProps = function receiveProps(props) {
      this.props = props;
    };

    Source.prototype.receiveComponent = function receiveComponent(component) {
      this.component = component;
    };

    Source.prototype.canDrag = function canDrag() {
      if (!spec.canDrag) {
        return true;
      }

      return spec.canDrag(this.props, this.monitor);
    };

    Source.prototype.isDragging = function isDragging(globalMonitor, sourceId) {
      if (!spec.isDragging) {
        return sourceId === globalMonitor.getSourceId();
      }

      return spec.isDragging(this.props, this.monitor);
    };

    Source.prototype.beginDrag = function beginDrag() {
      var item = spec.beginDrag(this.props, this.monitor, this.component);
      if (process.env.NODE_ENV !== 'production') {
        _invariant2['default'](_lodashIsPlainObject2['default'](item), 'beginDrag() must return a plain object that represents the dragged item. ' + 'Instead received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source.html', item);
      }
      return item;
    };

    Source.prototype.endDrag = function endDrag() {
      if (!spec.endDrag) {
        return;
      }

      spec.endDrag(this.props, this.monitor, this.component);
    };

    return Source;
  })();

  return function createSource(monitor) {
    return new Source(monitor);
  };
}

module.exports = exports['default'];
}).call(this,require('_process'))

},{"_process":89,"invariant":88,"lodash/isPlainObject":203}],185:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createSourceMonitor;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var isCallingCanDrag = false;
var isCallingIsDragging = false;

var SourceMonitor = (function () {
  function SourceMonitor(manager) {
    _classCallCheck(this, SourceMonitor);

    this.internalMonitor = manager.getMonitor();
  }

  SourceMonitor.prototype.receiveHandlerId = function receiveHandlerId(sourceId) {
    this.sourceId = sourceId;
  };

  SourceMonitor.prototype.canDrag = function canDrag() {
    _invariant2['default'](!isCallingCanDrag, 'You may not call monitor.canDrag() inside your canDrag() implementation. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source-monitor.html');

    try {
      isCallingCanDrag = true;
      return this.internalMonitor.canDragSource(this.sourceId);
    } finally {
      isCallingCanDrag = false;
    }
  };

  SourceMonitor.prototype.isDragging = function isDragging() {
    _invariant2['default'](!isCallingIsDragging, 'You may not call monitor.isDragging() inside your isDragging() implementation. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drag-source-monitor.html');

    try {
      isCallingIsDragging = true;
      return this.internalMonitor.isDraggingSource(this.sourceId);
    } finally {
      isCallingIsDragging = false;
    }
  };

  SourceMonitor.prototype.getItemType = function getItemType() {
    return this.internalMonitor.getItemType();
  };

  SourceMonitor.prototype.getItem = function getItem() {
    return this.internalMonitor.getItem();
  };

  SourceMonitor.prototype.getDropResult = function getDropResult() {
    return this.internalMonitor.getDropResult();
  };

  SourceMonitor.prototype.didDrop = function didDrop() {
    return this.internalMonitor.didDrop();
  };

  SourceMonitor.prototype.getInitialClientOffset = function getInitialClientOffset() {
    return this.internalMonitor.getInitialClientOffset();
  };

  SourceMonitor.prototype.getInitialSourceClientOffset = function getInitialSourceClientOffset() {
    return this.internalMonitor.getInitialSourceClientOffset();
  };

  SourceMonitor.prototype.getSourceClientOffset = function getSourceClientOffset() {
    return this.internalMonitor.getSourceClientOffset();
  };

  SourceMonitor.prototype.getClientOffset = function getClientOffset() {
    return this.internalMonitor.getClientOffset();
  };

  SourceMonitor.prototype.getDifferenceFromInitialOffset = function getDifferenceFromInitialOffset() {
    return this.internalMonitor.getDifferenceFromInitialOffset();
  };

  return SourceMonitor;
})();

function createSourceMonitor(manager) {
  return new SourceMonitor(manager);
}

module.exports = exports['default'];
},{"invariant":88}],186:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createTargetConnector;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _wrapConnectorHooks = require('./wrapConnectorHooks');

var _wrapConnectorHooks2 = _interopRequireDefault(_wrapConnectorHooks);

var _areOptionsEqual = require('./areOptionsEqual');

var _areOptionsEqual2 = _interopRequireDefault(_areOptionsEqual);

function createTargetConnector(backend) {
  var currentHandlerId = undefined;

  var currentDropTargetNode = undefined;
  var currentDropTargetOptions = undefined;
  var disconnectCurrentDropTarget = undefined;

  function reconnectDropTarget() {
    if (disconnectCurrentDropTarget) {
      disconnectCurrentDropTarget();
      disconnectCurrentDropTarget = null;
    }

    if (currentHandlerId && currentDropTargetNode) {
      disconnectCurrentDropTarget = backend.connectDropTarget(currentHandlerId, currentDropTargetNode, currentDropTargetOptions);
    }
  }

  function receiveHandlerId(handlerId) {
    if (handlerId === currentHandlerId) {
      return;
    }

    currentHandlerId = handlerId;
    reconnectDropTarget();
  }

  var hooks = _wrapConnectorHooks2['default']({
    dropTarget: function connectDropTarget(node, options) {
      if (node === currentDropTargetNode && _areOptionsEqual2['default'](options, currentDropTargetOptions)) {
        return;
      }

      currentDropTargetNode = node;
      currentDropTargetOptions = options;

      reconnectDropTarget();
    }
  });

  return {
    receiveHandlerId: receiveHandlerId,
    hooks: hooks
  };
}

module.exports = exports['default'];
},{"./areOptionsEqual":182,"./wrapConnectorHooks":198}],187:[function(require,module,exports){
(function (process){
'use strict';

exports.__esModule = true;
exports['default'] = createTargetFactory;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var ALLOWED_SPEC_METHODS = ['canDrop', 'hover', 'drop'];

function createTargetFactory(spec) {
  Object.keys(spec).forEach(function (key) {
    _invariant2['default'](ALLOWED_SPEC_METHODS.indexOf(key) > -1, 'Expected the drop target specification to only have ' + 'some of the following keys: %s. ' + 'Instead received a specification with an unexpected "%s" key. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', ALLOWED_SPEC_METHODS.join(', '), key);
    _invariant2['default'](typeof spec[key] === 'function', 'Expected %s in the drop target specification to be a function. ' + 'Instead received a specification with %s: %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', key, key, spec[key]);
  });

  var Target = (function () {
    function Target(monitor) {
      _classCallCheck(this, Target);

      this.monitor = monitor;
      this.props = null;
      this.component = null;
    }

    Target.prototype.receiveProps = function receiveProps(props) {
      this.props = props;
    };

    Target.prototype.receiveMonitor = function receiveMonitor(monitor) {
      this.monitor = monitor;
    };

    Target.prototype.receiveComponent = function receiveComponent(component) {
      this.component = component;
    };

    Target.prototype.canDrop = function canDrop() {
      if (!spec.canDrop) {
        return true;
      }

      return spec.canDrop(this.props, this.monitor);
    };

    Target.prototype.hover = function hover() {
      if (!spec.hover) {
        return;
      }

      spec.hover(this.props, this.monitor, this.component);
    };

    Target.prototype.drop = function drop() {
      if (!spec.drop) {
        return;
      }

      var dropResult = spec.drop(this.props, this.monitor, this.component);
      if (process.env.NODE_ENV !== 'production') {
        _invariant2['default'](typeof dropResult === 'undefined' || _lodashIsPlainObject2['default'](dropResult), 'drop() must either return undefined, or an object that represents the drop result. ' + 'Instead received %s. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target.html', dropResult);
      }
      return dropResult;
    };

    return Target;
  })();

  return function createTarget(monitor) {
    return new Target(monitor);
  };
}

module.exports = exports['default'];
}).call(this,require('_process'))

},{"_process":89,"invariant":88,"lodash/isPlainObject":203}],188:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = createTargetMonitor;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var isCallingCanDrop = false;

var TargetMonitor = (function () {
  function TargetMonitor(manager) {
    _classCallCheck(this, TargetMonitor);

    this.internalMonitor = manager.getMonitor();
  }

  TargetMonitor.prototype.receiveHandlerId = function receiveHandlerId(targetId) {
    this.targetId = targetId;
  };

  TargetMonitor.prototype.canDrop = function canDrop() {
    _invariant2['default'](!isCallingCanDrop, 'You may not call monitor.canDrop() inside your canDrop() implementation. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-drop-target-monitor.html');

    try {
      isCallingCanDrop = true;
      return this.internalMonitor.canDropOnTarget(this.targetId);
    } finally {
      isCallingCanDrop = false;
    }
  };

  TargetMonitor.prototype.isOver = function isOver(options) {
    return this.internalMonitor.isOverTarget(this.targetId, options);
  };

  TargetMonitor.prototype.getItemType = function getItemType() {
    return this.internalMonitor.getItemType();
  };

  TargetMonitor.prototype.getItem = function getItem() {
    return this.internalMonitor.getItem();
  };

  TargetMonitor.prototype.getDropResult = function getDropResult() {
    return this.internalMonitor.getDropResult();
  };

  TargetMonitor.prototype.didDrop = function didDrop() {
    return this.internalMonitor.didDrop();
  };

  TargetMonitor.prototype.getInitialClientOffset = function getInitialClientOffset() {
    return this.internalMonitor.getInitialClientOffset();
  };

  TargetMonitor.prototype.getInitialSourceClientOffset = function getInitialSourceClientOffset() {
    return this.internalMonitor.getInitialSourceClientOffset();
  };

  TargetMonitor.prototype.getSourceClientOffset = function getSourceClientOffset() {
    return this.internalMonitor.getSourceClientOffset();
  };

  TargetMonitor.prototype.getClientOffset = function getClientOffset() {
    return this.internalMonitor.getClientOffset();
  };

  TargetMonitor.prototype.getDifferenceFromInitialOffset = function getDifferenceFromInitialOffset() {
    return this.internalMonitor.getDifferenceFromInitialOffset();
  };

  return TargetMonitor;
})();

function createTargetMonitor(manager) {
  return new TargetMonitor(manager);
}

module.exports = exports['default'];
},{"invariant":88}],189:[function(require,module,exports){
(function (process){
'use strict';

exports.__esModule = true;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

exports['default'] = decorateHandler;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

function _inherits(subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _disposables = require('disposables');

var _utilsShallowEqual = require('./utils/shallowEqual');

var _utilsShallowEqual2 = _interopRequireDefault(_utilsShallowEqual);

var _utilsShallowEqualScalar = require('./utils/shallowEqualScalar');

var _utilsShallowEqualScalar2 = _interopRequireDefault(_utilsShallowEqualScalar);

var _lodashIsPlainObject = require('lodash/isPlainObject');

var _lodashIsPlainObject2 = _interopRequireDefault(_lodashIsPlainObject);

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

function decorateHandler(_ref) {
  var DecoratedComponent = _ref.DecoratedComponent;
  var createHandler = _ref.createHandler;
  var createMonitor = _ref.createMonitor;
  var createConnector = _ref.createConnector;
  var registerHandler = _ref.registerHandler;
  var containerDisplayName = _ref.containerDisplayName;
  var getType = _ref.getType;
  var collect = _ref.collect;
  var options = _ref.options;
  var _options$arePropsEqual = options.arePropsEqual;
  var arePropsEqual = _options$arePropsEqual === undefined ? _utilsShallowEqualScalar2['default'] : _options$arePropsEqual;

  var displayName = DecoratedComponent.displayName || DecoratedComponent.name || 'Component';

  return (function (_Component) {
    _inherits(DragDropContainer, _Component);

    DragDropContainer.prototype.getHandlerId = function getHandlerId() {
      return this.handlerId;
    };

    DragDropContainer.prototype.getDecoratedComponentInstance = function getDecoratedComponentInstance() {
      return this.decoratedComponentInstance;
    };

    DragDropContainer.prototype.shouldComponentUpdate = function shouldComponentUpdate(nextProps, nextState) {
      return !arePropsEqual(nextProps, this.props) || !_utilsShallowEqual2['default'](nextState, this.state);
    };

    _createClass(DragDropContainer, null, [{
      key: 'DecoratedComponent',
      value: DecoratedComponent,
      enumerable: true
    }, {
      key: 'displayName',
      value: containerDisplayName + '(' + displayName + ')',
      enumerable: true
    }, {
      key: 'contextTypes',
      value: {
        dragDropManager: _react.PropTypes.object.isRequired
      },
      enumerable: true
    }]);

    function DragDropContainer(props, context) {
      _classCallCheck(this, DragDropContainer);

      _Component.call(this, props, context);
      this.handleChange = this.handleChange.bind(this);
      this.handleChildRef = this.handleChildRef.bind(this);

      _invariant2['default'](typeof this.context.dragDropManager === 'object', 'Could not find the drag and drop manager in the context of %s. ' + 'Make sure to wrap the top-level component of your app with DragDropContext. ' + 'Read more: http://gaearon.github.io/react-dnd/docs-troubleshooting.html#could-not-find-the-drag-and-drop-manager-in-the-context', displayName, displayName);

      this.manager = this.context.dragDropManager;
      this.handlerMonitor = createMonitor(this.manager);
      this.handlerConnector = createConnector(this.manager.getBackend());
      this.handler = createHandler(this.handlerMonitor);

      this.disposable = new _disposables.SerialDisposable();
      this.receiveProps(props);
      this.state = this.getCurrentState();
      this.dispose();
    }

    DragDropContainer.prototype.componentDidMount = function componentDidMount() {
      this.isCurrentlyMounted = true;
      this.disposable = new _disposables.SerialDisposable();
      this.currentType = null;
      this.receiveProps(this.props);
      this.handleChange();
    };

    DragDropContainer.prototype.componentWillReceiveProps = function componentWillReceiveProps(nextProps) {
      if (!arePropsEqual(nextProps, this.props)) {
        this.receiveProps(nextProps);
        this.handleChange();
      }
    };

    DragDropContainer.prototype.componentWillUnmount = function componentWillUnmount() {
      this.dispose();
      this.isCurrentlyMounted = false;
    };

    DragDropContainer.prototype.receiveProps = function receiveProps(props) {
      this.handler.receiveProps(props);
      this.receiveType(getType(props));
    };

    DragDropContainer.prototype.receiveType = function receiveType(type) {
      if (type === this.currentType) {
        return;
      }

      this.currentType = type;

      var _registerHandler = registerHandler(type, this.handler, this.manager);

      var handlerId = _registerHandler.handlerId;
      var unregister = _registerHandler.unregister;

      this.handlerId = handlerId;
      this.handlerMonitor.receiveHandlerId(handlerId);
      this.handlerConnector.receiveHandlerId(handlerId);

      var globalMonitor = this.manager.getMonitor();
      var unsubscribe = globalMonitor.subscribeToStateChange(this.handleChange, { handlerIds: [handlerId] });

      this.disposable.setDisposable(new _disposables.CompositeDisposable(new _disposables.Disposable(unsubscribe), new _disposables.Disposable(unregister)));
    };

    DragDropContainer.prototype.handleChange = function handleChange() {
      if (!this.isCurrentlyMounted) {
        return;
      }

      var nextState = this.getCurrentState();
      if (!_utilsShallowEqual2['default'](nextState, this.state)) {
        this.setState(nextState);
      }
    };

    DragDropContainer.prototype.dispose = function dispose() {
      this.disposable.dispose();
      this.handlerConnector.receiveHandlerId(null);
    };

    DragDropContainer.prototype.handleChildRef = function handleChildRef(component) {
      this.decoratedComponentInstance = component;
      this.handler.receiveComponent(component);
    };

    DragDropContainer.prototype.getCurrentState = function getCurrentState() {
      var nextState = collect(this.handlerConnector.hooks, this.handlerMonitor);

      if (process.env.NODE_ENV !== 'production') {
        _invariant2['default'](_lodashIsPlainObject2['default'](nextState), 'Expected `collect` specified as the second argument to ' + '%s for %s to return a plain object of props to inject. ' + 'Instead, received %s.', containerDisplayName, displayName, nextState);
      }

      return nextState;
    };

    DragDropContainer.prototype.render = function render() {
      return _react2['default'].createElement(DecoratedComponent, _extends({}, this.props, this.state, {
        ref: this.handleChildRef }));
    };

    return DragDropContainer;
  })(_react.Component);
}

module.exports = exports['default'];
}).call(this,require('_process'))

},{"./utils/shallowEqual":196,"./utils/shallowEqualScalar":197,"_process":89,"disposables":6,"invariant":88,"lodash/isPlainObject":203,"react":undefined}],190:[function(require,module,exports){
'use strict';

exports.__esModule = true;

function _interopRequire(obj) { return obj && obj.__esModule ? obj['default'] : obj; }

var _DragDropContext = require('./DragDropContext');

exports.DragDropContext = _interopRequire(_DragDropContext);

var _DragLayer = require('./DragLayer');

exports.DragLayer = _interopRequire(_DragLayer);

var _DragSource = require('./DragSource');

exports.DragSource = _interopRequire(_DragSource);

var _DropTarget = require('./DropTarget');

exports.DropTarget = _interopRequire(_DropTarget);
},{"./DragDropContext":178,"./DragLayer":179,"./DragSource":180,"./DropTarget":181}],191:[function(require,module,exports){
"use strict";

exports.__esModule = true;
exports["default"] = registerSource;

function registerSource(type, source, manager) {
  var registry = manager.getRegistry();
  var sourceId = registry.addSource(type, source);

  function unregisterSource() {
    registry.removeSource(sourceId);
  }

  return {
    handlerId: sourceId,
    unregister: unregisterSource
  };
}

module.exports = exports["default"];
},{}],192:[function(require,module,exports){
"use strict";

exports.__esModule = true;
exports["default"] = registerTarget;

function registerTarget(type, target, manager) {
  var registry = manager.getRegistry();
  var targetId = registry.addTarget(type, target);

  function unregisterTarget() {
    registry.removeTarget(targetId);
  }

  return {
    handlerId: targetId,
    unregister: unregisterTarget
  };
}

module.exports = exports["default"];
},{}],193:[function(require,module,exports){
(function (process){
'use strict';

exports.__esModule = true;
exports['default'] = checkDecoratorArguments;

function checkDecoratorArguments(functionName, signature) {
  if (process.env.NODE_ENV !== 'production') {
    for (var _len = arguments.length, args = Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) {
      args[_key - 2] = arguments[_key];
    }

    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (arg && arg.prototype && arg.prototype.render) {
        console.error( // eslint-disable-line no-console
        'You seem to be applying the arguments in the wrong order. ' + ('It should be ' + functionName + '(' + signature + ')(Component), not the other way around. ') + 'Read more: http://gaearon.github.io/react-dnd/docs-troubleshooting.html#you-seem-to-be-applying-the-arguments-in-the-wrong-order');
        return;
      }
    }
  }
}

module.exports = exports['default'];
}).call(this,require('_process'))

},{"_process":89}],194:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = cloneWithRef;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _invariant = require('invariant');

var _invariant2 = _interopRequireDefault(_invariant);

var _react = require('react');

function cloneWithRef(element, newRef) {
  var previousRef = element.ref;
  _invariant2['default'](typeof previousRef !== 'string', 'Cannot connect React DnD to an element with an existing string ref. ' + 'Please convert it to use a callback ref instead, or wrap it into a <span> or <div>. ' + 'Read more: https://facebook.github.io/react/docs/more-about-refs.html#the-ref-callback-attribute');

  if (!previousRef) {
    // When there is no ref on the element, use the new ref directly
    return _react.cloneElement(element, {
      ref: newRef
    });
  }

  return _react.cloneElement(element, {
    ref: function ref(node) {
      newRef(node);

      if (previousRef) {
        previousRef(node);
      }
    }
  });
}

module.exports = exports['default'];
},{"invariant":88,"react":undefined}],195:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = isValidType;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _lodashIsArray = require('lodash/isArray');

var _lodashIsArray2 = _interopRequireDefault(_lodashIsArray);

function isValidType(type, allowArray) {
       return typeof type === 'string' || typeof type === 'symbol' || allowArray && _lodashIsArray2['default'](type) && type.every(function (t) {
              return isValidType(t, false);
       });
}

module.exports = exports['default'];
},{"lodash/isArray":201}],196:[function(require,module,exports){
arguments[4][99][0].apply(exports,arguments)
},{"dup":99}],197:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = shallowEqualScalar;

function shallowEqualScalar(objA, objB) {
  if (objA === objB) {
    return true;
  }

  if (typeof objA !== 'object' || objA === null || typeof objB !== 'object' || objB === null) {
    return false;
  }

  var keysA = Object.keys(objA);
  var keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  // Test for A's keys different from B.
  var hasOwn = Object.prototype.hasOwnProperty;
  for (var i = 0; i < keysA.length; i++) {
    if (!hasOwn.call(objB, keysA[i])) {
      return false;
    }

    var valA = objA[keysA[i]];
    var valB = objB[keysA[i]];

    if (valA !== valB || typeof valA === 'object' || typeof valB === 'object') {
      return false;
    }
  }

  return true;
}

module.exports = exports['default'];
},{}],198:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports['default'] = wrapConnectorHooks;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _utilsCloneWithRef = require('./utils/cloneWithRef');

var _utilsCloneWithRef2 = _interopRequireDefault(_utilsCloneWithRef);

var _react = require('react');

function throwIfCompositeComponentElement(element) {
  // Custom components can no longer be wrapped directly in React DnD 2.0
  // so that we don't need to depend on findDOMNode() from react-dom.
  if (typeof element.type === 'string') {
    return;
  }

  var displayName = element.type.displayName || element.type.name || 'the component';

  throw new Error('Only native element nodes can now be passed to React DnD connectors. ' + ('You can either wrap ' + displayName + ' into a <div>, or turn it into a ') + 'drag source or a drop target itself.');
}

function wrapHookToRecognizeElement(hook) {
  return function () {
    var elementOrNode = arguments.length <= 0 || arguments[0] === undefined ? null : arguments[0];
    var options = arguments.length <= 1 || arguments[1] === undefined ? null : arguments[1];

    // When passed a node, call the hook straight away.
    if (!_react.isValidElement(elementOrNode)) {
      var node = elementOrNode;
      hook(node, options);
      return;
    }

    // If passed a ReactElement, clone it and attach this function as a ref.
    // This helps us achieve a neat API where user doesn't even know that refs
    // are being used under the hood.
    var element = elementOrNode;
    throwIfCompositeComponentElement(element);

    // When no options are passed, use the hook directly
    var ref = options ? function (node) {
      return hook(node, options);
    } : hook;

    return _utilsCloneWithRef2['default'](element, ref);
  };
}

function wrapConnectorHooks(hooks) {
  var wrappedHooks = {};

  Object.keys(hooks).forEach(function (key) {
    var hook = hooks[key];
    var wrappedHook = wrapHookToRecognizeElement(hook);
    wrappedHooks[key] = function () {
      return wrappedHook;
    };
  });

  return wrappedHooks;
}

module.exports = exports['default'];
},{"./utils/cloneWithRef":194,"react":undefined}],199:[function(require,module,exports){
/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeGetPrototype = Object.getPrototypeOf;

/**
 * Gets the `[[Prototype]]` of `value`.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {null|Object} Returns the `[[Prototype]]`.
 */
function getPrototype(value) {
  return nativeGetPrototype(Object(value));
}

module.exports = getPrototype;

},{}],200:[function(require,module,exports){
arguments[4][60][0].apply(exports,arguments)
},{"dup":60}],201:[function(require,module,exports){
arguments[4][73][0].apply(exports,arguments)
},{"dup":73}],202:[function(require,module,exports){
arguments[4][80][0].apply(exports,arguments)
},{"dup":80}],203:[function(require,module,exports){
var getPrototype = require('./_getPrototype'),
    isHostObject = require('./_isHostObject'),
    isObjectLike = require('./isObjectLike');

/** `Object#toString` result references. */
var objectTag = '[object Object]';

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to resolve the decompiled source of functions. */
var funcToString = Function.prototype.toString;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/** Used to infer the `Object` constructor. */
var objectCtorString = funcToString.call(Object);

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
 * of values.
 */
var objectToString = objectProto.toString;

/**
 * Checks if `value` is a plain object, that is, an object created by the
 * `Object` constructor or one with a `[[Prototype]]` of `null`.
 *
 * @static
 * @memberOf _
 * @since 0.8.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a plain object,
 *  else `false`.
 * @example
 *
 * function Foo() {
 *   this.a = 1;
 * }
 *
 * _.isPlainObject(new Foo);
 * // => false
 *
 * _.isPlainObject([1, 2, 3]);
 * // => false
 *
 * _.isPlainObject({ 'x': 0, 'y': 0 });
 * // => true
 *
 * _.isPlainObject(Object.create(null));
 * // => true
 */
function isPlainObject(value) {
  if (!isObjectLike(value) ||
      objectToString.call(value) != objectTag || isHostObject(value)) {
    return false;
  }
  var proto = getPrototype(value);
  if (proto === null) {
    return true;
  }
  var Ctor = hasOwnProperty.call(proto, 'constructor') && proto.constructor;
  return (typeof Ctor == 'function' &&
    Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString);
}

module.exports = isPlainObject;

},{"./_getPrototype":199,"./_isHostObject":200,"./isObjectLike":202}],204:[function(require,module,exports){
'use strict';

exports.__esModule = true;
exports.ActionTypes = undefined;
exports["default"] = createStore;

var _isPlainObject = require('lodash/isPlainObject');

var _isPlainObject2 = _interopRequireDefault(_isPlainObject);

var _symbolObservable = require('symbol-observable');

var _symbolObservable2 = _interopRequireDefault(_symbolObservable);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }

/**
 * These are private action types reserved by Redux.
 * For any unknown actions, you must return the current state.
 * If the current state is undefined, you must return the initial state.
 * Do not reference these action types directly in your code.
 */
var ActionTypes = exports.ActionTypes = {
  INIT: '@@redux/INIT'
};

/**
 * Creates a Redux store that holds the state tree.
 * The only way to change the data in the store is to call `dispatch()` on it.
 *
 * There should only be a single store in your app. To specify how different
 * parts of the state tree respond to actions, you may combine several reducers
 * into a single reducer function by using `combineReducers`.
 *
 * @param {Function} reducer A function that returns the next state tree, given
 * the current state tree and the action to handle.
 *
 * @param {any} [initialState] The initial state. You may optionally specify it
 * to hydrate the state from the server in universal apps, or to restore a
 * previously serialized user session.
 * If you use `combineReducers` to produce the root reducer function, this must be
 * an object with the same shape as `combineReducers` keys.
 *
 * @param {Function} enhancer The store enhancer. You may optionally specify it
 * to enhance the store with third-party capabilities such as middleware,
 * time travel, persistence, etc. The only store enhancer that ships with Redux
 * is `applyMiddleware()`.
 *
 * @returns {Store} A Redux store that lets you read the state, dispatch actions
 * and subscribe to changes.
 */
function createStore(reducer, initialState, enhancer) {
  var _ref2;

  if (typeof initialState === 'function' && typeof enhancer === 'undefined') {
    enhancer = initialState;
    initialState = undefined;
  }

  if (typeof enhancer !== 'undefined') {
    if (typeof enhancer !== 'function') {
      throw new Error('Expected the enhancer to be a function.');
    }

    return enhancer(createStore)(reducer, initialState);
  }

  if (typeof reducer !== 'function') {
    throw new Error('Expected the reducer to be a function.');
  }

  var currentReducer = reducer;
  var currentState = initialState;
  var currentListeners = [];
  var nextListeners = currentListeners;
  var isDispatching = false;

  function ensureCanMutateNextListeners() {
    if (nextListeners === currentListeners) {
      nextListeners = currentListeners.slice();
    }
  }

  /**
   * Reads the state tree managed by the store.
   *
   * @returns {any} The current state tree of your application.
   */
  function getState() {
    return currentState;
  }

  /**
   * Adds a change listener. It will be called any time an action is dispatched,
   * and some part of the state tree may potentially have changed. You may then
   * call `getState()` to read the current state tree inside the callback.
   *
   * You may call `dispatch()` from a change listener, with the following
   * caveats:
   *
   * 1. The subscriptions are snapshotted just before every `dispatch()` call.
   * If you subscribe or unsubscribe while the listeners are being invoked, this
   * will not have any effect on the `dispatch()` that is currently in progress.
   * However, the next `dispatch()` call, whether nested or not, will use a more
   * recent snapshot of the subscription list.
   *
   * 2. The listener should not expect to see all state changes, as the state
   * might have been updated multiple times during a nested `dispatch()` before
   * the listener is called. It is, however, guaranteed that all subscribers
   * registered before the `dispatch()` started will be called with the latest
   * state by the time it exits.
   *
   * @param {Function} listener A callback to be invoked on every dispatch.
   * @returns {Function} A function to remove this change listener.
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('Expected listener to be a function.');
    }

    var isSubscribed = true;

    ensureCanMutateNextListeners();
    nextListeners.push(listener);

    return function unsubscribe() {
      if (!isSubscribed) {
        return;
      }

      isSubscribed = false;

      ensureCanMutateNextListeners();
      var index = nextListeners.indexOf(listener);
      nextListeners.splice(index, 1);
    };
  }

  /**
   * Dispatches an action. It is the only way to trigger a state change.
   *
   * The `reducer` function, used to create the store, will be called with the
   * current state tree and the given `action`. Its return value will
   * be considered the **next** state of the tree, and the change listeners
   * will be notified.
   *
   * The base implementation only supports plain object actions. If you want to
   * dispatch a Promise, an Observable, a thunk, or something else, you need to
   * wrap your store creating function into the corresponding middleware. For
   * example, see the documentation for the `redux-thunk` package. Even the
   * middleware will eventually dispatch plain object actions using this method.
   *
   * @param {Object} action A plain object representing “what changed”. It is
   * a good idea to keep actions serializable so you can record and replay user
   * sessions, or use the time travelling `redux-devtools`. An action must have
   * a `type` property which may not be `undefined`. It is a good idea to use
   * string constants for action types.
   *
   * @returns {Object} For convenience, the same action object you dispatched.
   *
   * Note that, if you use a custom middleware, it may wrap `dispatch()` to
   * return something else (for example, a Promise you can await).
   */
  function dispatch(action) {
    if (!(0, _isPlainObject2["default"])(action)) {
      throw new Error('Actions must be plain objects. ' + 'Use custom middleware for async actions.');
    }

    if (typeof action.type === 'undefined') {
      throw new Error('Actions may not have an undefined "type" property. ' + 'Have you misspelled a constant?');
    }

    if (isDispatching) {
      throw new Error('Reducers may not dispatch actions.');
    }

    try {
      isDispatching = true;
      currentState = currentReducer(currentState, action);
    } finally {
      isDispatching = false;
    }

    var listeners = currentListeners = nextListeners;
    for (var i = 0; i < listeners.length; i++) {
      listeners[i]();
    }

    return action;
  }

  /**
   * Replaces the reducer currently used by the store to calculate the state.
   *
   * You might need this if your app implements code splitting and you want to
   * load some of the reducers dynamically. You might also need this if you
   * implement a hot reloading mechanism for Redux.
   *
   * @param {Function} nextReducer The reducer for the store to use instead.
   * @returns {void}
   */
  function replaceReducer(nextReducer) {
    if (typeof nextReducer !== 'function') {
      throw new Error('Expected the nextReducer to be a function.');
    }

    currentReducer = nextReducer;
    dispatch({ type: ActionTypes.INIT });
  }

  /**
   * Interoperability point for observable/reactive libraries.
   * @returns {observable} A minimal observable of state changes.
   * For more information, see the observable proposal:
   * https://github.com/zenparsing/es-observable
   */
  function observable() {
    var _ref;

    var outerSubscribe = subscribe;
    return _ref = {
      /**
       * The minimal observable subscription method.
       * @param {Object} observer Any object that can be used as an observer.
       * The observer object should have a `next` method.
       * @returns {subscription} An object with an `unsubscribe` method that can
       * be used to unsubscribe the observable from the store, and prevent further
       * emission of values from the observable.
       */

      subscribe: function subscribe(observer) {
        if (typeof observer !== 'object') {
          throw new TypeError('Expected the observer to be an object.');
        }

        function observeState() {
          if (observer.next) {
            observer.next(getState());
          }
        }

        observeState();
        var unsubscribe = outerSubscribe(observeState);
        return { unsubscribe: unsubscribe };
      }
    }, _ref[_symbolObservable2["default"]] = function () {
      return this;
    }, _ref;
  }

  // When a store is created, an "INIT" action is dispatched so that every
  // reducer returns their initial state. This effectively populates
  // the initial state tree.
  dispatch({ type: ActionTypes.INIT });

  return _ref2 = {
    dispatch: dispatch,
    subscribe: subscribe,
    getState: getState,
    replaceReducer: replaceReducer
  }, _ref2[_symbolObservable2["default"]] = observable, _ref2;
}
},{"lodash/isPlainObject":208,"symbol-observable":209}],205:[function(require,module,exports){
arguments[4][199][0].apply(exports,arguments)
},{"dup":199}],206:[function(require,module,exports){
arguments[4][60][0].apply(exports,arguments)
},{"dup":60}],207:[function(require,module,exports){
arguments[4][80][0].apply(exports,arguments)
},{"dup":80}],208:[function(require,module,exports){
arguments[4][203][0].apply(exports,arguments)
},{"./_getPrototype":205,"./_isHostObject":206,"./isObjectLike":207,"dup":203}],209:[function(require,module,exports){
(function (global){
/* global window */
'use strict';

module.exports = require('./ponyfill')(global || window || this);

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./ponyfill":210}],210:[function(require,module,exports){
'use strict';

module.exports = function symbolObservablePonyfill(root) {
	var result;
	var Symbol = root.Symbol;

	if (typeof Symbol === 'function') {
		if (Symbol.observable) {
			result = Symbol.observable;
		} else {
			if (typeof Symbol.for === 'function') {
				result = Symbol.for('observable');
			} else {
				result = Symbol('observable');
			}
			Symbol.observable = result;
		}
	} else {
		result = '@@observable';
	}

	return result;
};

},{}],211:[function(require,module,exports){
'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _Select = require('./Select');

var _Select2 = _interopRequireDefault(_Select);

var _utilsStripDiacritics = require('./utils/stripDiacritics');

var _utilsStripDiacritics2 = _interopRequireDefault(_utilsStripDiacritics);

var requestId = 0;

function initCache(cache) {
	if (cache && typeof cache !== 'object') {
		cache = {};
	}
	return cache ? cache : null;
}

function updateCache(cache, input, data) {
	if (!cache) return;
	cache[input] = data;
}

function getFromCache(cache, input) {
	if (!cache) return;
	for (var i = input.length; i >= 0; --i) {
		var cacheKey = input.slice(0, i);
		if (cache[cacheKey] && (input === cacheKey || cache[cacheKey].complete)) {
			return cache[cacheKey];
		}
	}
}

function thenPromise(promise, callback) {
	if (!promise || typeof promise.then !== 'function') return;
	return promise.then(function (data) {
		callback(null, data);
	}, function (err) {
		callback(err);
	});
}

var stringOrNode = _react2['default'].PropTypes.oneOfType([_react2['default'].PropTypes.string, _react2['default'].PropTypes.node]);

var Async = _react2['default'].createClass({
	displayName: 'Async',

	propTypes: {
		cache: _react2['default'].PropTypes.any, // object to use to cache results, can be null to disable cache
		ignoreAccents: _react2['default'].PropTypes.bool, // whether to strip diacritics when filtering (shared with Select)
		ignoreCase: _react2['default'].PropTypes.bool, // whether to perform case-insensitive filtering (shared with Select)
		isLoading: _react2['default'].PropTypes.bool, // overrides the isLoading state when set to true
		loadOptions: _react2['default'].PropTypes.func.isRequired, // function to call to load options asynchronously
		loadingPlaceholder: _react2['default'].PropTypes.string, // replaces the placeholder while options are loading
		minimumInput: _react2['default'].PropTypes.number, // the minimum number of characters that trigger loadOptions
		noResultsText: stringOrNode, // placeholder displayed when there are no matching search results (shared with Select)
		placeholder: stringOrNode, // field placeholder, displayed when there's no value (shared with Select)
		searchPromptText: _react2['default'].PropTypes.string, // label to prompt for search input
		searchingText: _react2['default'].PropTypes.string },
	// message to display while options are loading
	getDefaultProps: function getDefaultProps() {
		return {
			cache: true,
			ignoreAccents: true,
			ignoreCase: true,
			loadingPlaceholder: 'Loading...',
			minimumInput: 0,
			searchingText: 'Searching...',
			searchPromptText: 'Type to search'
		};
	},
	getInitialState: function getInitialState() {
		return {
			cache: initCache(this.props.cache),
			isLoading: false,
			options: []
		};
	},
	componentWillMount: function componentWillMount() {
		this._lastInput = '';
	},
	componentDidMount: function componentDidMount() {
		this.loadOptions('');
	},
	componentWillReceiveProps: function componentWillReceiveProps(nextProps) {
		if (nextProps.cache !== this.props.cache) {
			this.setState({
				cache: initCache(nextProps.cache)
			});
		}
	},
	focus: function focus() {
		this.refs.select.focus();
	},
	resetState: function resetState() {
		this._currentRequestId = -1;
		this.setState({
			isLoading: false,
			options: []
		});
	},
	getResponseHandler: function getResponseHandler(input) {
		var _this = this;

		var _requestId = this._currentRequestId = requestId++;
		return function (err, data) {
			if (err) throw err;
			if (!_this.isMounted()) return;
			updateCache(_this.state.cache, input, data);
			if (_requestId !== _this._currentRequestId) return;
			_this.setState({
				isLoading: false,
				options: data && data.options || []
			});
		};
	},
	loadOptions: function loadOptions(input) {
		if (this.props.ignoreAccents) input = (0, _utilsStripDiacritics2['default'])(input);
		if (this.props.ignoreCase) input = input.toLowerCase();
		this._lastInput = input;
		if (input.length < this.props.minimumInput) {
			return this.resetState();
		}
		var cacheResult = getFromCache(this.state.cache, input);
		if (cacheResult) {
			return this.setState({
				options: cacheResult.options
			});
		}
		this.setState({
			isLoading: true
		});
		var responseHandler = this.getResponseHandler(input);
		return thenPromise(this.props.loadOptions(input, responseHandler), responseHandler);
	},
	render: function render() {
		var noResultsText = this.props.noResultsText;
		var _state = this.state;
		var isLoading = _state.isLoading;
		var options = _state.options;

		if (this.props.isLoading) isLoading = true;
		var placeholder = isLoading ? this.props.loadingPlaceholder : this.props.placeholder;
		if (!options.length) {
			if (this._lastInput.length < this.props.minimumInput) noResultsText = this.props.searchPromptText;
			if (isLoading) noResultsText = this.props.searchingText;
		}
		return _react2['default'].createElement(_Select2['default'], _extends({}, this.props, {
			ref: 'select',
			isLoading: isLoading,
			noResultsText: noResultsText,
			onInputChange: this.loadOptions,
			options: options,
			placeholder: placeholder
		}));
	}
});

module.exports = Async;

},{"./Select":"react-select","./utils/stripDiacritics":215,"react":undefined}],212:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _objectWithoutProperties(obj, keys) { var target = {}; for (var i in obj) { if (keys.indexOf(i) >= 0) continue; if (!Object.prototype.hasOwnProperty.call(obj, i)) continue; target[i] = obj[i]; } return target; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _classnames = require('classnames');

var _classnames2 = _interopRequireDefault(_classnames);

var _reactDnd = require('react-dnd');

var itemSource = {
  beginDrag: function beginDrag(props) {
    return { value: props.value };
  }
};

var itemTarget = {
  hover: function hover(props, monitor) {
    var item = monitor.getItem().value;
    if (item !== props.value) {
      props.moveItem(item, props.value);
    }
  }
};

function collectDrag(connect, monitor) {
  return {
    connectDragSource: connect.dragSource(),
    draggingOpacity: monitor.isDragging() ? 0.3 : null
  };
}

function collectDrop(connect) {
  return {
    connectDropTarget: connect.dropTarget()
  };
}

var DraggableValue = function DraggableValue(Component) {
  return (0, _reactDnd.DragSource)("DraggableSelect", itemSource, collectDrag)((0, _reactDnd.DropTarget)("DraggableSelect", itemTarget, collectDrop)(_react2['default'].createClass({
    render: function render() {
      var _props = this.props;
      var connectDragSource = _props.connectDragSource;
      var connectDropTarget = _props.connectDropTarget;
      var draggingOpacity = _props.draggingOpacity;

      var rest = _objectWithoutProperties(_props, ['connectDragSource', 'connectDropTarget', 'draggingOpacity']);

      return connectDragSource(connectDropTarget(_react2['default'].createElement(
        'span',
        { style: { opacity: draggingOpacity },
          onMouseDown: function (e) {
            return e.stopPropagation();
          } },
        _react2['default'].createElement(Component, rest)
      )));
    }
  })));
};

var DraggableSelect = function DraggableSelect(Component, ValueComponent) {
  return _react2['default'].createClass({
    moveItem: function moveItem(src, dest) {
      var _props2 = this.props;
      var onChange = _props2.onChange;
      var value = _props2.value;
      var values = value.map(function (d) {
        return d.value;
      });
      var srcIndex = values.indexOf(src.value);
      var destIndex = values.indexOf(dest.value);
      var valueCopy = value.concat([]);

      valueCopy.splice(srcIndex, 1);
      valueCopy.splice(destIndex, 0, src);

      onChange(valueCopy);
    },

    render: function render() {
      return _react2['default'].createElement(Component, _extends({}, this.props, {
        multi: true,
        moveItem: this.moveItem,
        valueComponent: ValueComponent }));
    }
  });
};

exports.DraggableSelect = DraggableSelect;
exports.DraggableValue = DraggableValue;

},{"classnames":undefined,"react":undefined,"react-dnd":190}],213:[function(require,module,exports){
'use strict';

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _classnames = require('classnames');

var _classnames2 = _interopRequireDefault(_classnames);

var Option = _react2['default'].createClass({
	displayName: 'Option',

	propTypes: {
		children: _react2['default'].PropTypes.node,
		className: _react2['default'].PropTypes.string, // className (based on mouse position)
		isDisabled: _react2['default'].PropTypes.bool, // the option is disabled
		isFocused: _react2['default'].PropTypes.bool, // the option is focused
		isSelected: _react2['default'].PropTypes.bool, // the option is selected
		onFocus: _react2['default'].PropTypes.func, // method to handle mouseEnter on option element
		onSelect: _react2['default'].PropTypes.func, // method to handle click on option element
		onUnfocus: _react2['default'].PropTypes.func, // method to handle mouseLeave on option element
		option: _react2['default'].PropTypes.object.isRequired },
	// object that is base for that option
	blockEvent: function blockEvent(event) {
		event.preventDefault();
		event.stopPropagation();
		if (event.target.tagName !== 'A' || !('href' in event.target)) {
			return;
		}
		if (event.target.target) {
			window.open(event.target.href, event.target.target);
		} else {
			window.location.href = event.target.href;
		}
	},

	handleMouseDown: function handleMouseDown(event) {
		event.preventDefault();
		event.stopPropagation();
		this.props.onSelect(this.props.option, event);
	},

	handleMouseEnter: function handleMouseEnter(event) {
		this.onFocus(event);
	},

	handleMouseMove: function handleMouseMove(event) {
		this.onFocus(event);
	},

	handleTouchEnd: function handleTouchEnd(event) {
		// Check if the view is being dragged, In this case
		// we don't want to fire the click event (because the user only wants to scroll)
		if (this.dragging) return;

		this.handleMouseDown(event);
	},

	handleTouchMove: function handleTouchMove(event) {
		// Set a flag that the view is being dragged
		this.dragging = true;
	},

	handleTouchStart: function handleTouchStart(event) {
		// Set a flag that the view is not being dragged
		this.dragging = false;
	},

	onFocus: function onFocus(event) {
		if (!this.props.isFocused) {
			this.props.onFocus(this.props.option, event);
		}
	},
	render: function render() {
		var option = this.props.option;

		var className = (0, _classnames2['default'])(this.props.className, option.className);

		return option.disabled ? _react2['default'].createElement(
			'div',
			{ className: className,
				onMouseDown: this.blockEvent,
				onClick: this.blockEvent },
			this.props.children
		) : _react2['default'].createElement(
			'div',
			{ className: className,
				style: option.style,
				onMouseDown: this.handleMouseDown,
				onMouseEnter: this.handleMouseEnter,
				onMouseMove: this.handleMouseMove,
				onTouchStart: this.handleTouchStart,
				onTouchMove: this.handleTouchMove,
				onTouchEnd: this.handleTouchEnd,
				title: option.title },
			this.props.children
		);
	}
});

module.exports = Option;

},{"classnames":undefined,"react":undefined}],214:[function(require,module,exports){
'use strict';

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _classnames = require('classnames');

var _classnames2 = _interopRequireDefault(_classnames);

var Value = _react2['default'].createClass({

	displayName: 'Value',

	propTypes: {
		children: _react2['default'].PropTypes.node,
		disabled: _react2['default'].PropTypes.bool, // disabled prop passed to ReactSelect
		onClick: _react2['default'].PropTypes.func, // method to handle click on value label
		onRemove: _react2['default'].PropTypes.func, // method to handle removal of the value
		value: _react2['default'].PropTypes.object.isRequired },

	// the option object for this value
	handleMouseDown: function handleMouseDown(event) {
		if (event.type === 'mousedown' && event.button !== 0) {
			return;
		}
		if (this.props.onClick) {
			event.stopPropagation();
			this.props.onClick(this.props.value, event);
			return;
		}
		if (this.props.value.href) {
			event.stopPropagation();
		}
	},

	onRemove: function onRemove(event) {
		event.preventDefault();
		event.stopPropagation();
		this.props.onRemove(this.props.value);
	},

	handleTouchEndRemove: function handleTouchEndRemove(event) {
		// Check if the view is being dragged, In this case
		// we don't want to fire the click event (because the user only wants to scroll)
		if (this.dragging) return;

		// Fire the mouse events
		this.onRemove(event);
	},

	handleTouchMove: function handleTouchMove(event) {
		// Set a flag that the view is being dragged
		this.dragging = true;
	},

	handleTouchStart: function handleTouchStart(event) {
		// Set a flag that the view is not being dragged
		this.dragging = false;
	},

	renderRemoveIcon: function renderRemoveIcon() {
		if (this.props.disabled || !this.props.onRemove) return;
		return _react2['default'].createElement(
			'span',
			{ className: 'Select-value-icon',
				onMouseDown: this.onRemove,
				onTouchEnd: this.handleTouchEndRemove,
				onTouchStart: this.handleTouchStart,
				onTouchMove: this.handleTouchMove },
			'×'
		);
	},

	renderLabel: function renderLabel() {
		var className = 'Select-value-label';
		return this.props.onClick || this.props.value.href ? _react2['default'].createElement(
			'a',
			{ className: className, href: this.props.value.href, target: this.props.value.target, onMouseDown: this.handleMouseDown, onTouchEnd: this.handleMouseDown },
			this.props.children
		) : _react2['default'].createElement(
			'span',
			{ className: className },
			this.props.children
		);
	},

	render: function render() {
		return _react2['default'].createElement(
			'div',
			{ className: (0, _classnames2['default'])('Select-value', this.props.value.className),
				style: this.props.value.style,
				title: this.props.value.title
			},
			this.renderRemoveIcon(),
			this.renderLabel()
		);
	}

});

module.exports = Value;

},{"classnames":undefined,"react":undefined}],215:[function(require,module,exports){
'use strict';

var map = [{ 'base': 'A', 'letters': /[\u0041\u24B6\uFF21\u00C0\u00C1\u00C2\u1EA6\u1EA4\u1EAA\u1EA8\u00C3\u0100\u0102\u1EB0\u1EAE\u1EB4\u1EB2\u0226\u01E0\u00C4\u01DE\u1EA2\u00C5\u01FA\u01CD\u0200\u0202\u1EA0\u1EAC\u1EB6\u1E00\u0104\u023A\u2C6F]/g }, { 'base': 'AA', 'letters': /[\uA732]/g }, { 'base': 'AE', 'letters': /[\u00C6\u01FC\u01E2]/g }, { 'base': 'AO', 'letters': /[\uA734]/g }, { 'base': 'AU', 'letters': /[\uA736]/g }, { 'base': 'AV', 'letters': /[\uA738\uA73A]/g }, { 'base': 'AY', 'letters': /[\uA73C]/g }, { 'base': 'B', 'letters': /[\u0042\u24B7\uFF22\u1E02\u1E04\u1E06\u0243\u0182\u0181]/g }, { 'base': 'C', 'letters': /[\u0043\u24B8\uFF23\u0106\u0108\u010A\u010C\u00C7\u1E08\u0187\u023B\uA73E]/g }, { 'base': 'D', 'letters': /[\u0044\u24B9\uFF24\u1E0A\u010E\u1E0C\u1E10\u1E12\u1E0E\u0110\u018B\u018A\u0189\uA779]/g }, { 'base': 'DZ', 'letters': /[\u01F1\u01C4]/g }, { 'base': 'Dz', 'letters': /[\u01F2\u01C5]/g }, { 'base': 'E', 'letters': /[\u0045\u24BA\uFF25\u00C8\u00C9\u00CA\u1EC0\u1EBE\u1EC4\u1EC2\u1EBC\u0112\u1E14\u1E16\u0114\u0116\u00CB\u1EBA\u011A\u0204\u0206\u1EB8\u1EC6\u0228\u1E1C\u0118\u1E18\u1E1A\u0190\u018E]/g }, { 'base': 'F', 'letters': /[\u0046\u24BB\uFF26\u1E1E\u0191\uA77B]/g }, { 'base': 'G', 'letters': /[\u0047\u24BC\uFF27\u01F4\u011C\u1E20\u011E\u0120\u01E6\u0122\u01E4\u0193\uA7A0\uA77D\uA77E]/g }, { 'base': 'H', 'letters': /[\u0048\u24BD\uFF28\u0124\u1E22\u1E26\u021E\u1E24\u1E28\u1E2A\u0126\u2C67\u2C75\uA78D]/g }, { 'base': 'I', 'letters': /[\u0049\u24BE\uFF29\u00CC\u00CD\u00CE\u0128\u012A\u012C\u0130\u00CF\u1E2E\u1EC8\u01CF\u0208\u020A\u1ECA\u012E\u1E2C\u0197]/g }, { 'base': 'J', 'letters': /[\u004A\u24BF\uFF2A\u0134\u0248]/g }, { 'base': 'K', 'letters': /[\u004B\u24C0\uFF2B\u1E30\u01E8\u1E32\u0136\u1E34\u0198\u2C69\uA740\uA742\uA744\uA7A2]/g }, { 'base': 'L', 'letters': /[\u004C\u24C1\uFF2C\u013F\u0139\u013D\u1E36\u1E38\u013B\u1E3C\u1E3A\u0141\u023D\u2C62\u2C60\uA748\uA746\uA780]/g }, { 'base': 'LJ', 'letters': /[\u01C7]/g }, { 'base': 'Lj', 'letters': /[\u01C8]/g }, { 'base': 'M', 'letters': /[\u004D\u24C2\uFF2D\u1E3E\u1E40\u1E42\u2C6E\u019C]/g }, { 'base': 'N', 'letters': /[\u004E\u24C3\uFF2E\u01F8\u0143\u00D1\u1E44\u0147\u1E46\u0145\u1E4A\u1E48\u0220\u019D\uA790\uA7A4]/g }, { 'base': 'NJ', 'letters': /[\u01CA]/g }, { 'base': 'Nj', 'letters': /[\u01CB]/g }, { 'base': 'O', 'letters': /[\u004F\u24C4\uFF2F\u00D2\u00D3\u00D4\u1ED2\u1ED0\u1ED6\u1ED4\u00D5\u1E4C\u022C\u1E4E\u014C\u1E50\u1E52\u014E\u022E\u0230\u00D6\u022A\u1ECE\u0150\u01D1\u020C\u020E\u01A0\u1EDC\u1EDA\u1EE0\u1EDE\u1EE2\u1ECC\u1ED8\u01EA\u01EC\u00D8\u01FE\u0186\u019F\uA74A\uA74C]/g }, { 'base': 'OI', 'letters': /[\u01A2]/g }, { 'base': 'OO', 'letters': /[\uA74E]/g }, { 'base': 'OU', 'letters': /[\u0222]/g }, { 'base': 'P', 'letters': /[\u0050\u24C5\uFF30\u1E54\u1E56\u01A4\u2C63\uA750\uA752\uA754]/g }, { 'base': 'Q', 'letters': /[\u0051\u24C6\uFF31\uA756\uA758\u024A]/g }, { 'base': 'R', 'letters': /[\u0052\u24C7\uFF32\u0154\u1E58\u0158\u0210\u0212\u1E5A\u1E5C\u0156\u1E5E\u024C\u2C64\uA75A\uA7A6\uA782]/g }, { 'base': 'S', 'letters': /[\u0053\u24C8\uFF33\u1E9E\u015A\u1E64\u015C\u1E60\u0160\u1E66\u1E62\u1E68\u0218\u015E\u2C7E\uA7A8\uA784]/g }, { 'base': 'T', 'letters': /[\u0054\u24C9\uFF34\u1E6A\u0164\u1E6C\u021A\u0162\u1E70\u1E6E\u0166\u01AC\u01AE\u023E\uA786]/g }, { 'base': 'TZ', 'letters': /[\uA728]/g }, { 'base': 'U', 'letters': /[\u0055\u24CA\uFF35\u00D9\u00DA\u00DB\u0168\u1E78\u016A\u1E7A\u016C\u00DC\u01DB\u01D7\u01D5\u01D9\u1EE6\u016E\u0170\u01D3\u0214\u0216\u01AF\u1EEA\u1EE8\u1EEE\u1EEC\u1EF0\u1EE4\u1E72\u0172\u1E76\u1E74\u0244]/g }, { 'base': 'V', 'letters': /[\u0056\u24CB\uFF36\u1E7C\u1E7E\u01B2\uA75E\u0245]/g }, { 'base': 'VY', 'letters': /[\uA760]/g }, { 'base': 'W', 'letters': /[\u0057\u24CC\uFF37\u1E80\u1E82\u0174\u1E86\u1E84\u1E88\u2C72]/g }, { 'base': 'X', 'letters': /[\u0058\u24CD\uFF38\u1E8A\u1E8C]/g }, { 'base': 'Y', 'letters': /[\u0059\u24CE\uFF39\u1EF2\u00DD\u0176\u1EF8\u0232\u1E8E\u0178\u1EF6\u1EF4\u01B3\u024E\u1EFE]/g }, { 'base': 'Z', 'letters': /[\u005A\u24CF\uFF3A\u0179\u1E90\u017B\u017D\u1E92\u1E94\u01B5\u0224\u2C7F\u2C6B\uA762]/g }, { 'base': 'a', 'letters': /[\u0061\u24D0\uFF41\u1E9A\u00E0\u00E1\u00E2\u1EA7\u1EA5\u1EAB\u1EA9\u00E3\u0101\u0103\u1EB1\u1EAF\u1EB5\u1EB3\u0227\u01E1\u00E4\u01DF\u1EA3\u00E5\u01FB\u01CE\u0201\u0203\u1EA1\u1EAD\u1EB7\u1E01\u0105\u2C65\u0250]/g }, { 'base': 'aa', 'letters': /[\uA733]/g }, { 'base': 'ae', 'letters': /[\u00E6\u01FD\u01E3]/g }, { 'base': 'ao', 'letters': /[\uA735]/g }, { 'base': 'au', 'letters': /[\uA737]/g }, { 'base': 'av', 'letters': /[\uA739\uA73B]/g }, { 'base': 'ay', 'letters': /[\uA73D]/g }, { 'base': 'b', 'letters': /[\u0062\u24D1\uFF42\u1E03\u1E05\u1E07\u0180\u0183\u0253]/g }, { 'base': 'c', 'letters': /[\u0063\u24D2\uFF43\u0107\u0109\u010B\u010D\u00E7\u1E09\u0188\u023C\uA73F\u2184]/g }, { 'base': 'd', 'letters': /[\u0064\u24D3\uFF44\u1E0B\u010F\u1E0D\u1E11\u1E13\u1E0F\u0111\u018C\u0256\u0257\uA77A]/g }, { 'base': 'dz', 'letters': /[\u01F3\u01C6]/g }, { 'base': 'e', 'letters': /[\u0065\u24D4\uFF45\u00E8\u00E9\u00EA\u1EC1\u1EBF\u1EC5\u1EC3\u1EBD\u0113\u1E15\u1E17\u0115\u0117\u00EB\u1EBB\u011B\u0205\u0207\u1EB9\u1EC7\u0229\u1E1D\u0119\u1E19\u1E1B\u0247\u025B\u01DD]/g }, { 'base': 'f', 'letters': /[\u0066\u24D5\uFF46\u1E1F\u0192\uA77C]/g }, { 'base': 'g', 'letters': /[\u0067\u24D6\uFF47\u01F5\u011D\u1E21\u011F\u0121\u01E7\u0123\u01E5\u0260\uA7A1\u1D79\uA77F]/g }, { 'base': 'h', 'letters': /[\u0068\u24D7\uFF48\u0125\u1E23\u1E27\u021F\u1E25\u1E29\u1E2B\u1E96\u0127\u2C68\u2C76\u0265]/g }, { 'base': 'hv', 'letters': /[\u0195]/g }, { 'base': 'i', 'letters': /[\u0069\u24D8\uFF49\u00EC\u00ED\u00EE\u0129\u012B\u012D\u00EF\u1E2F\u1EC9\u01D0\u0209\u020B\u1ECB\u012F\u1E2D\u0268\u0131]/g }, { 'base': 'j', 'letters': /[\u006A\u24D9\uFF4A\u0135\u01F0\u0249]/g }, { 'base': 'k', 'letters': /[\u006B\u24DA\uFF4B\u1E31\u01E9\u1E33\u0137\u1E35\u0199\u2C6A\uA741\uA743\uA745\uA7A3]/g }, { 'base': 'l', 'letters': /[\u006C\u24DB\uFF4C\u0140\u013A\u013E\u1E37\u1E39\u013C\u1E3D\u1E3B\u017F\u0142\u019A\u026B\u2C61\uA749\uA781\uA747]/g }, { 'base': 'lj', 'letters': /[\u01C9]/g }, { 'base': 'm', 'letters': /[\u006D\u24DC\uFF4D\u1E3F\u1E41\u1E43\u0271\u026F]/g }, { 'base': 'n', 'letters': /[\u006E\u24DD\uFF4E\u01F9\u0144\u00F1\u1E45\u0148\u1E47\u0146\u1E4B\u1E49\u019E\u0272\u0149\uA791\uA7A5]/g }, { 'base': 'nj', 'letters': /[\u01CC]/g }, { 'base': 'o', 'letters': /[\u006F\u24DE\uFF4F\u00F2\u00F3\u00F4\u1ED3\u1ED1\u1ED7\u1ED5\u00F5\u1E4D\u022D\u1E4F\u014D\u1E51\u1E53\u014F\u022F\u0231\u00F6\u022B\u1ECF\u0151\u01D2\u020D\u020F\u01A1\u1EDD\u1EDB\u1EE1\u1EDF\u1EE3\u1ECD\u1ED9\u01EB\u01ED\u00F8\u01FF\u0254\uA74B\uA74D\u0275]/g }, { 'base': 'oi', 'letters': /[\u01A3]/g }, { 'base': 'ou', 'letters': /[\u0223]/g }, { 'base': 'oo', 'letters': /[\uA74F]/g }, { 'base': 'p', 'letters': /[\u0070\u24DF\uFF50\u1E55\u1E57\u01A5\u1D7D\uA751\uA753\uA755]/g }, { 'base': 'q', 'letters': /[\u0071\u24E0\uFF51\u024B\uA757\uA759]/g }, { 'base': 'r', 'letters': /[\u0072\u24E1\uFF52\u0155\u1E59\u0159\u0211\u0213\u1E5B\u1E5D\u0157\u1E5F\u024D\u027D\uA75B\uA7A7\uA783]/g }, { 'base': 's', 'letters': /[\u0073\u24E2\uFF53\u00DF\u015B\u1E65\u015D\u1E61\u0161\u1E67\u1E63\u1E69\u0219\u015F\u023F\uA7A9\uA785\u1E9B]/g }, { 'base': 't', 'letters': /[\u0074\u24E3\uFF54\u1E6B\u1E97\u0165\u1E6D\u021B\u0163\u1E71\u1E6F\u0167\u01AD\u0288\u2C66\uA787]/g }, { 'base': 'tz', 'letters': /[\uA729]/g }, { 'base': 'u', 'letters': /[\u0075\u24E4\uFF55\u00F9\u00FA\u00FB\u0169\u1E79\u016B\u1E7B\u016D\u00FC\u01DC\u01D8\u01D6\u01DA\u1EE7\u016F\u0171\u01D4\u0215\u0217\u01B0\u1EEB\u1EE9\u1EEF\u1EED\u1EF1\u1EE5\u1E73\u0173\u1E77\u1E75\u0289]/g }, { 'base': 'v', 'letters': /[\u0076\u24E5\uFF56\u1E7D\u1E7F\u028B\uA75F\u028C]/g }, { 'base': 'vy', 'letters': /[\uA761]/g }, { 'base': 'w', 'letters': /[\u0077\u24E6\uFF57\u1E81\u1E83\u0175\u1E87\u1E85\u1E98\u1E89\u2C73]/g }, { 'base': 'x', 'letters': /[\u0078\u24E7\uFF58\u1E8B\u1E8D]/g }, { 'base': 'y', 'letters': /[\u0079\u24E8\uFF59\u1EF3\u00FD\u0177\u1EF9\u0233\u1E8F\u00FF\u1EF7\u1E99\u1EF5\u01B4\u024F\u1EFF]/g }, { 'base': 'z', 'letters': /[\u007A\u24E9\uFF5A\u017A\u1E91\u017C\u017E\u1E93\u1E95\u01B6\u0225\u0240\u2C6C\uA763]/g }];

module.exports = function stripDiacritics(str) {
	for (var i = 0; i < map.length; i++) {
		str = str.replace(map[i].letters, map[i].base);
	}
	return str;
};

},{}],"react-select":[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', {
	value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _reactDom = require('react-dom');

var _reactDom2 = _interopRequireDefault(_reactDom);

var _reactInputAutosize = require('react-input-autosize');

var _reactInputAutosize2 = _interopRequireDefault(_reactInputAutosize);

var _classnames = require('classnames');

var _classnames2 = _interopRequireDefault(_classnames);

var _utilsStripDiacritics = require('./utils/stripDiacritics');

var _utilsStripDiacritics2 = _interopRequireDefault(_utilsStripDiacritics);

var _Async = require('./Async');

var _Async2 = _interopRequireDefault(_Async);

var _Option = require('./Option');

var _Option2 = _interopRequireDefault(_Option);

var _Value = require('./Value');

var _Value2 = _interopRequireDefault(_Value);

var _Draggable = require('./Draggable');

var _reactDnd = require('react-dnd');

var _reactDndHtml5Backend = require('react-dnd-html5-backend');

var _reactDndHtml5Backend2 = _interopRequireDefault(_reactDndHtml5Backend);

function stringifyValue(value) {
	if (typeof value === 'object') {
		return JSON.stringify(value);
	} else {
		return value;
	}
}

var stringOrNode = _react2['default'].PropTypes.oneOfType([_react2['default'].PropTypes.string, _react2['default'].PropTypes.node]);

var Select = _react2['default'].createClass({

	displayName: 'Select',

	propTypes: {
		addLabelText: _react2['default'].PropTypes.string, // placeholder displayed when you want to add a label on a multi-value input
		allowCreate: _react2['default'].PropTypes.bool, // whether to allow creation of new entries
		openOnFocus: _react2['default'].PropTypes.bool, // always open options menu on focus
		autoBlur: _react2['default'].PropTypes.bool, // automatically blur the component when an option is selected
		autofocus: _react2['default'].PropTypes.bool, // autofocus the component on mount
		autosize: _react2['default'].PropTypes.bool, // whether to enable autosizing or not
		backspaceRemoves: _react2['default'].PropTypes.bool, // whether backspace removes an item if there is no text input
		className: _react2['default'].PropTypes.string, // className for the outer element
		clearAllText: stringOrNode, // title for the "clear" control when multi: true
		clearValueText: stringOrNode, // title for the "clear" control
		clearable: _react2['default'].PropTypes.bool, // should it be possible to reset value
		delimiter: _react2['default'].PropTypes.string, // delimiter to use to join multiple values for the hidden field value
		disabled: _react2['default'].PropTypes.bool, // whether the Select is disabled or not
		escapeClearsValue: _react2['default'].PropTypes.bool, // whether escape clears the value when the menu is closed
		filterOption: _react2['default'].PropTypes.func, // method to filter a single option (option, filterString)
		filterOptions: _react2['default'].PropTypes.any, // boolean to enable default filtering or function to filter the options array ([options], filterString, [values])
		ignoreAccents: _react2['default'].PropTypes.bool, // whether to strip diacritics when filtering
		ignoreCase: _react2['default'].PropTypes.bool, // whether to perform case-insensitive filtering
		inputProps: _react2['default'].PropTypes.object, // custom attributes for the Input
		isLoading: _react2['default'].PropTypes.bool, // whether the Select is loading externally or not (such as options being loaded)
		joinValues: _react2['default'].PropTypes.bool, // joins multiple values into a single form field with the delimiter (legacy mode)
		labelKey: _react2['default'].PropTypes.string, // path of the label value in option objects
		matchPos: _react2['default'].PropTypes.string, // (any|start) match the start or entire string when filtering
		matchProp: _react2['default'].PropTypes.string, // (any|label|value) which option property to filter on
		menuBuffer: _react2['default'].PropTypes.number, // optional buffer (in px) between the bottom of the viewport and the bottom of the menu
		menuContainerStyle: _react2['default'].PropTypes.object, // optional style to apply to the menu container
		menuRenderer: _react2['default'].PropTypes.func, // renders a custom menu with options
		menuStyle: _react2['default'].PropTypes.object, // optional style to apply to the menu
		multi: _react2['default'].PropTypes.bool, // multi-value input
		name: _react2['default'].PropTypes.string, // generates a hidden <input /> tag with this field name for html forms
		newOptionCreator: _react2['default'].PropTypes.func, // factory to create new options when allowCreate set
		noResultsText: stringOrNode, // placeholder displayed when there are no matching search results
		onBlur: _react2['default'].PropTypes.func, // onBlur handler: function (event) {}
		onBlurResetsInput: _react2['default'].PropTypes.bool, // whether input is cleared on blur
		onChange: _react2['default'].PropTypes.func, // onChange handler: function (newValue) {}
		onClose: _react2['default'].PropTypes.func, // fires when the menu is closed
		onFocus: _react2['default'].PropTypes.func, // onFocus handler: function (event) {}
		onInputChange: _react2['default'].PropTypes.func, // onInputChange handler: function (inputValue) {}
		onMenuScrollToBottom: _react2['default'].PropTypes.func, // fires when the menu is scrolled to the bottom; can be used to paginate options
		onOpen: _react2['default'].PropTypes.func, // fires when the menu is opened
		onValueClick: _react2['default'].PropTypes.func, // onClick handler for value labels: function (value, event) {}
		openAfterFocus: _react2['default'].PropTypes.bool, // boolean to enable opening dropdown when focused
		optionClassName: _react2['default'].PropTypes.string, // additional class(es) to apply to the <Option /> elements
		optionComponent: _react2['default'].PropTypes.func, // option component to render in dropdown
		optionRenderer: _react2['default'].PropTypes.func, // optionRenderer: function (option) {}
		options: _react2['default'].PropTypes.array, // array of options
		placeholder: stringOrNode, // field placeholder, displayed when there's no value
		required: _react2['default'].PropTypes.bool, // applies HTML5 required attribute when needed
		scrollMenuIntoView: _react2['default'].PropTypes.bool, // boolean to enable the viewport to shift so that the full menu fully visible when engaged
		searchable: _react2['default'].PropTypes.bool, // whether to enable searching feature or not
		simpleValue: _react2['default'].PropTypes.bool, // pass the value to onChange as a simple value (legacy pre 1.0 mode), defaults to false
		style: _react2['default'].PropTypes.object, // optional style to apply to the control
		tabIndex: _react2['default'].PropTypes.string, // optional tab index of the control
		tabSelectsValue: _react2['default'].PropTypes.bool, // whether to treat tabbing out while focused to be value selection
		value: _react2['default'].PropTypes.any, // initial field value
		valueComponent: _react2['default'].PropTypes.func, // value component to render
		valueKey: _react2['default'].PropTypes.string, // path of the label value in option objects
		valueRenderer: _react2['default'].PropTypes.func, // valueRenderer: function (option) {}
		wrapperStyle: _react2['default'].PropTypes.object },

	// optional style to apply to the component wrapper
	statics: { Async: _Async2['default'] },

	getDefaultProps: function getDefaultProps() {
		return {
			addLabelText: 'Add "{label}"?',
			autosize: true,
			allowCreate: false,
			backspaceRemoves: true,
			clearable: true,
			clearAllText: 'Clear all',
			clearValueText: 'Clear value',
			delimiter: ',',
			disabled: false,
			escapeClearsValue: true,
			filterOptions: true,
			ignoreAccents: true,
			ignoreCase: true,
			inputProps: {},
			isLoading: false,
			joinValues: false,
			labelKey: 'label',
			matchPos: 'any',
			matchProp: 'any',
			menuBuffer: 0,
			multi: false,
			noResultsText: 'No results found',
			onBlurResetsInput: true,
			openAfterFocus: false,
			optionComponent: _Option2['default'],
			placeholder: 'Select...',
			required: false,
			scrollMenuIntoView: true,
			searchable: true,
			simpleValue: false,
			tabSelectsValue: true,
			valueComponent: _Value2['default'],
			valueKey: 'value'
		};
	},

	getInitialState: function getInitialState() {
		return {
			inputValue: '',
			isFocused: false,
			isLoading: false,
			isOpen: false,
			isPseudoFocused: false,
			required: this.props.required && this.handleRequired(this.props.value, this.props.multi)
		};
	},

	componentDidMount: function componentDidMount() {
		if (this.props.autofocus) {
			this.focus();
		}
	},

	componentWillReceiveProps: function componentWillReceiveProps(nextProps) {
		if (this.props.value !== nextProps.value && nextProps.required) {
			this.setState({
				required: this.handleRequired(nextProps.value, nextProps.multi)
			});
		}
	},

	componentWillUpdate: function componentWillUpdate(nextProps, nextState) {
		if (nextState.isOpen !== this.state.isOpen) {
			var handler = nextState.isOpen ? nextProps.onOpen : nextProps.onClose;
			handler && handler();
		}
	},

	componentDidUpdate: function componentDidUpdate(prevProps, prevState) {
		// focus to the selected option
		if (this.refs.menu && this.refs.focused && this.state.isOpen && !this.hasScrolledToOption) {
			var focusedOptionNode = _reactDom2['default'].findDOMNode(this.refs.focused);
			var menuNode = _reactDom2['default'].findDOMNode(this.refs.menu);
			menuNode.scrollTop = focusedOptionNode.offsetTop;
			this.hasScrolledToOption = true;
		} else if (!this.state.isOpen) {
			this.hasScrolledToOption = false;
		}

		if (prevState.inputValue !== this.state.inputValue && this.props.onInputChange) {
			this.props.onInputChange(this.state.inputValue);
		}
		if (this._scrollToFocusedOptionOnUpdate && this.refs.focused && this.refs.menu) {
			this._scrollToFocusedOptionOnUpdate = false;
			var focusedDOM = _reactDom2['default'].findDOMNode(this.refs.focused);
			var menuDOM = _reactDom2['default'].findDOMNode(this.refs.menu);
			var focusedRect = focusedDOM.getBoundingClientRect();
			var menuRect = menuDOM.getBoundingClientRect();
			if (focusedRect.bottom > menuRect.bottom || focusedRect.top < menuRect.top) {
				menuDOM.scrollTop = focusedDOM.offsetTop + focusedDOM.clientHeight - menuDOM.offsetHeight;
			}
		}
		if (this.props.scrollMenuIntoView && this.refs.menuContainer) {
			var menuContainerRect = this.refs.menuContainer.getBoundingClientRect();
			if (window.innerHeight < menuContainerRect.bottom + this.props.menuBuffer) {
				window.scrollBy(0, menuContainerRect.bottom + this.props.menuBuffer - window.innerHeight);
			}
		}
		if (prevProps.disabled !== this.props.disabled) {
			this.setState({ isFocused: false }); // eslint-disable-line react/no-did-update-set-state
		}
	},

	focus: function focus() {
		if (!this.refs.input) return;
		this.refs.input.focus();

		if (this.props.openAfterFocus) {
			this.setState({
				isOpen: true
			});
		}
	},

	blurInput: function blurInput() {
		if (!this.refs.input) return;
		this.refs.input.blur();
	},

	handleTouchMove: function handleTouchMove(event) {
		// Set a flag that the view is being dragged
		this.dragging = true;
	},

	handleTouchStart: function handleTouchStart(event) {
		// Set a flag that the view is not being dragged
		this.dragging = false;
	},

	handleTouchEnd: function handleTouchEnd(event) {
		// Check if the view is being dragged, In this case
		// we don't want to fire the click event (because the user only wants to scroll)
		if (this.dragging) return;

		// Fire the mouse events
		this.handleMouseDown(event);
	},

	handleTouchEndClearValue: function handleTouchEndClearValue(event) {
		// Check if the view is being dragged, In this case
		// we don't want to fire the click event (because the user only wants to scroll)
		if (this.dragging) return;

		// Clear the value
		this.clearValue(event);
	},

	handleMouseDown: function handleMouseDown(event) {
		// if the event was triggered by a mousedown and not the primary
		// button, or if the component is disabled, ignore it.
		if (this.props.disabled || event.type === 'mousedown' && event.button !== 0) {
			return;
		}

		// prevent default event handlers
		event.stopPropagation();
		event.preventDefault();

		// for the non-searchable select, toggle the menu
		if (!this.props.searchable) {
			this.focus();
			return this.setState({
				isOpen: !this.state.isOpen
			});
		}

		if (this.state.isFocused) {
			// if the input is focused, ensure the menu is open
			this.setState({
				isOpen: true,
				isPseudoFocused: false
			});
		} else {
			// otherwise, focus the input and open the menu
			this._openAfterFocus = true;
			this.focus();
		}
	},

	handleMouseDownOnArrow: function handleMouseDownOnArrow(event) {
		// if the event was triggered by a mousedown and not the primary
		// button, or if the component is disabled, ignore it.
		if (this.props.disabled || event.type === 'mousedown' && event.button !== 0) {
			return;
		}
		// If the menu isn't open, let the event bubble to the main handleMouseDown
		if (!this.state.isOpen) {
			return;
		}
		// prevent default event handlers
		event.stopPropagation();
		event.preventDefault();
		// close the menu
		this.closeMenu();
	},

	handleMouseDownOnMenu: function handleMouseDownOnMenu(event) {
		// if the event was triggered by a mousedown and not the primary
		// button, or if the component is disabled, ignore it.
		if (this.props.disabled || event.type === 'mousedown' && event.button !== 0) {
			return;
		}
		event.stopPropagation();
		event.preventDefault();

		this._openAfterFocus = true;
		this.focus();
	},

	closeMenu: function closeMenu() {
		this.setState({
			isOpen: false,
			isPseudoFocused: this.state.isFocused && !this.props.multi,
			inputValue: ''
		});
		this.hasScrolledToOption = false;
	},

	handleInputFocus: function handleInputFocus(event) {
		var isOpen = this.state.isOpen || this._openAfterFocus || this.props.openOnFocus;
		if (this.props.onFocus) {
			this.props.onFocus(event);
		}
		this.setState({
			isFocused: true,
			isOpen: isOpen
		});
		this._openAfterFocus = false;
	},

	handleInputBlur: function handleInputBlur(event) {
		if (this.refs.menu && document.activeElement.isEqualNode(this.refs.menu)) {
			this.focus();
			return;
		}

		if (this.props.onBlur) {
			this.props.onBlur(event);
		}
		var onBlurredState = {
			isFocused: false,
			isOpen: false,
			isPseudoFocused: false
		};
		if (this.props.onBlurResetsInput) {
			onBlurredState.inputValue = '';
		}
		this.setState(onBlurredState);
	},

	handleInputChange: function handleInputChange(event) {
		this.setState({
			isOpen: true,
			isPseudoFocused: false,
			inputValue: event.target.value
		});
	},

	handleKeyDown: function handleKeyDown(event) {
		if (this.props.disabled) return;
		switch (event.keyCode) {
			case 8:
				// backspace
				if (!this.state.inputValue && this.props.backspaceRemoves) {
					event.preventDefault();
					this.popValue();
				}
				return;
			case 9:
				// tab
				if (event.shiftKey || !this.state.isOpen || !this.props.tabSelectsValue) {
					return;
				}
				this.selectFocusedOption();
				return;
			case 13:
				// enter
				if (!this.state.isOpen) return;
				event.stopPropagation();
				this.selectFocusedOption();
				break;
			case 27:
				// escape
				if (this.state.isOpen) {
					this.closeMenu();
				} else if (this.props.clearable && this.props.escapeClearsValue) {
					this.clearValue(event);
				}
				break;
			case 38:
				// up
				this.focusPreviousOption();
				break;
			case 40:
				// down
				this.focusNextOption();
				break;
			// case 188: // ,
			// 	if (this.props.allowCreate && this.props.multi) {
			// 		event.preventDefault();
			// 		event.stopPropagation();
			// 		this.selectFocusedOption();
			// 	} else {
			// 		return;
			// 	}
			// break;
			default:
				return;
		}
		event.preventDefault();
	},

	handleValueClick: function handleValueClick(option, event) {
		if (!this.props.onValueClick) return;
		this.props.onValueClick(option, event);
	},

	handleMenuScroll: function handleMenuScroll(event) {
		if (!this.props.onMenuScrollToBottom) return;
		var target = event.target;

		if (target.scrollHeight > target.offsetHeight && !(target.scrollHeight - target.offsetHeight - target.scrollTop)) {
			this.props.onMenuScrollToBottom();
		}
	},

	handleRequired: function handleRequired(value, multi) {
		if (!value) return true;
		return multi ? value.length === 0 : Object.keys(value).length === 0;
	},

	getOptionLabel: function getOptionLabel(op) {
		return op[this.props.labelKey];
	},

	getValueArray: function getValueArray() {
		var value = this.props.value;
		if (this.props.multi) {
			if (typeof value === 'string') value = value.split(this.props.delimiter);
			if (!Array.isArray(value)) {
				if (value === null || value === undefined) return [];
				value = [value];
			}
			return value.map(this.expandValue).filter(function (i) {
				return i;
			});
		}
		var expandedValue = this.expandValue(value);
		return expandedValue ? [expandedValue] : [];
	},

	expandValue: function expandValue(value) {
		if (typeof value !== 'string' && typeof value !== 'number') return value;
		var _props = this.props;
		var options = _props.options;
		var valueKey = _props.valueKey;

		if (!options) return;
		for (var i = 0; i < options.length; i++) {
			if (options[i][valueKey] === value) return options[i];
		}
	},

	setValue: function setValue(value) {
		var _this = this;

		if (this.props.autoBlur) {
			this.blurInput();
		}
		if (!this.props.onChange) return;
		if (this.props.required) {
			var required = this.handleRequired(value, this.props.multi);
			this.setState({ required: required });
		}
		if (this.props.simpleValue && value) {
			value = this.props.multi ? value.map(function (i) {
				return i[_this.props.valueKey];
			}).join(this.props.delimiter) : value[this.props.valueKey];
		}
		this.props.onChange(value);
	},

	selectValue: function selectValue(value) {
		this.hasScrolledToOption = false;
		if (this.props.multi) {
			this.addValue(value);
			this.setState({
				inputValue: ''
			});
		} else {
			this.setValue(value);
			this.setState({
				isOpen: false,
				inputValue: '',
				isPseudoFocused: this.state.isFocused
			});
		}
	},

	addValue: function addValue(value) {
		var valueArray = this.getValueArray();
		this.setValue(valueArray.concat(value));
	},

	popValue: function popValue() {
		var valueArray = this.getValueArray();
		if (!valueArray.length) return;
		if (valueArray[valueArray.length - 1].clearableValue === false) return;
		this.setValue(valueArray.slice(0, valueArray.length - 1));
	},

	removeValue: function removeValue(value) {
		var valueArray = this.getValueArray();
		this.setValue(valueArray.filter(function (i) {
			return i !== value;
		}));
		this.focus();
	},

	clearValue: function clearValue(event) {
		// if the event was triggered by a mousedown and not the primary
		// button, ignore it.
		if (event && event.type === 'mousedown' && event.button !== 0) {
			return;
		}
		event.stopPropagation();
		event.preventDefault();
		this.setValue(null);
		this.setState({
			isOpen: false,
			inputValue: ''
		}, this.focus);
	},

	focusOption: function focusOption(option) {
		this.setState({
			focusedOption: option
		});
	},

	focusNextOption: function focusNextOption() {
		this.focusAdjacentOption('next');
	},

	focusPreviousOption: function focusPreviousOption() {
		this.focusAdjacentOption('previous');
	},

	focusAdjacentOption: function focusAdjacentOption(dir) {
		var options = this._visibleOptions.filter(function (i) {
			return !i.disabled;
		});
		this._scrollToFocusedOptionOnUpdate = true;
		if (!this.state.isOpen) {
			this.setState({
				isOpen: true,
				inputValue: '',
				focusedOption: this._focusedOption || options[dir === 'next' ? 0 : options.length - 1]
			});
			return;
		}
		if (!options.length) return;
		var focusedIndex = -1;
		for (var i = 0; i < options.length; i++) {
			if (this._focusedOption === options[i]) {
				focusedIndex = i;
				break;
			}
		}
		var focusedOption = options[0];
		if (dir === 'next' && focusedIndex > -1 && focusedIndex < options.length - 1) {
			focusedOption = options[focusedIndex + 1];
		} else if (dir === 'previous') {
			if (focusedIndex > 0) {
				focusedOption = options[focusedIndex - 1];
			} else {
				focusedOption = options[options.length - 1];
			}
		}
		this.setState({
			focusedOption: focusedOption
		});
	},

	selectFocusedOption: function selectFocusedOption() {
		// if (this.props.allowCreate && !this.state.focusedOption) {
		// 	return this.selectValue(this.state.inputValue);
		// }
		if (this._focusedOption) {
			return this.selectValue(this._focusedOption);
		}
	},

	renderLoading: function renderLoading() {
		if (!this.props.isLoading) return;
		return _react2['default'].createElement(
			'span',
			{ className: 'Select-loading-zone', 'aria-hidden': 'true' },
			_react2['default'].createElement('span', { className: 'Select-loading' })
		);
	},

	renderValue: function renderValue(valueArray, isOpen) {
		var _this2 = this;

		var renderLabel = this.props.valueRenderer || this.getOptionLabel;
		var ValueComponent = this.props.valueComponent;
		if (!valueArray.length) {
			return !this.state.inputValue ? _react2['default'].createElement(
				'div',
				{ className: 'Select-placeholder' },
				this.props.placeholder
			) : null;
		}
		var onClick = this.props.onValueClick ? this.handleValueClick : null;
		if (this.props.multi) {
			return valueArray.map(function (value, i) {
				return _react2['default'].createElement(
					ValueComponent,
					{
						moveItem: _this2.props.moveItem,
						disabled: _this2.props.disabled || value.clearableValue === false,
						key: 'value-' + value[_this2.props.valueKey],
						onClick: onClick,
						onRemove: _this2.removeValue,
						value: value
					},
					renderLabel(value)
				);
			});
		} else if (!this.state.inputValue) {
			if (isOpen) onClick = null;
			return _react2['default'].createElement(
				ValueComponent,
				{
					disabled: this.props.disabled,
					onClick: onClick,
					value: valueArray[0]
				},
				renderLabel(valueArray[0])
			);
		}
	},

	renderInput: function renderInput(valueArray) {
		var className = (0, _classnames2['default'])('Select-input', this.props.inputProps.className);
		if (this.props.disabled || !this.props.searchable) {
			return _react2['default'].createElement('div', _extends({}, this.props.inputProps, {
				className: className,
				tabIndex: this.props.tabIndex || 0,
				onBlur: this.handleInputBlur,
				onFocus: this.handleInputFocus,
				ref: 'input',
				style: { border: 0, width: 1, display: 'inline-block' } }));
		}
		if (this.props.autosize) {
			return _react2['default'].createElement(_reactInputAutosize2['default'], _extends({}, this.props.inputProps, {
				className: className,
				tabIndex: this.props.tabIndex,
				onBlur: this.handleInputBlur,
				onChange: this.handleInputChange,
				onFocus: this.handleInputFocus,
				minWidth: '5',
				ref: 'input',
				required: this.state.required,
				value: this.state.inputValue
			}));
		}
		return _react2['default'].createElement(
			'div',
			{ className: className },
			_react2['default'].createElement('input', _extends({}, this.props.inputProps, {
				tabIndex: this.props.tabIndex,
				onBlur: this.handleInputBlur,
				onChange: this.handleInputChange,
				onFocus: this.handleInputFocus,
				ref: 'input',
				required: this.state.required,
				value: this.state.inputValue
			}))
		);
	},

	renderClear: function renderClear() {
		if (!this.props.clearable || !this.props.value || this.props.multi && !this.props.value.length || this.props.disabled || this.props.isLoading) return;
		return _react2['default'].createElement(
			'span',
			{ className: 'Select-clear-zone', title: this.props.multi ? this.props.clearAllText : this.props.clearValueText,
				'aria-label': this.props.multi ? this.props.clearAllText : this.props.clearValueText,
				onMouseDown: this.clearValue,
				onTouchStart: this.handleTouchStart,
				onTouchMove: this.handleTouchMove,
				onTouchEnd: this.handleTouchEndClearValue },
			_react2['default'].createElement('span', { className: 'Select-clear', dangerouslySetInnerHTML: { __html: '&times;' } })
		);
	},

	renderArrow: function renderArrow() {
		return _react2['default'].createElement(
			'span',
			{ className: 'Select-arrow-zone', onMouseDown: this.handleMouseDownOnArrow },
			_react2['default'].createElement('span', { className: 'Select-arrow', onMouseDown: this.handleMouseDownOnArrow })
		);
	},

	filterOptions: function filterOptions(excludeOptions) {
		var _this3 = this;

		var filterValue = this.state.inputValue;
		var options = this.props.options || [];
		if (typeof this.props.filterOptions === 'function') {
			return this.props.filterOptions.call(this, options, filterValue, excludeOptions);
		} else if (this.props.filterOptions) {
			if (this.props.ignoreAccents) {
				filterValue = (0, _utilsStripDiacritics2['default'])(filterValue);
			}
			if (this.props.ignoreCase) {
				filterValue = filterValue.toLowerCase();
			}
			if (excludeOptions) excludeOptions = excludeOptions.map(function (i) {
				return i[_this3.props.valueKey];
			});
			return options.filter(function (option) {
				if (excludeOptions && excludeOptions.indexOf(option[_this3.props.valueKey]) > -1) return false;
				if (_this3.props.filterOption) return _this3.props.filterOption.call(_this3, option, filterValue);
				if (!filterValue) return true;
				var valueTest = String(option[_this3.props.valueKey]);
				var labelTest = String(option[_this3.props.labelKey]);
				if (_this3.props.ignoreAccents) {
					if (_this3.props.matchProp !== 'label') valueTest = (0, _utilsStripDiacritics2['default'])(valueTest);
					if (_this3.props.matchProp !== 'value') labelTest = (0, _utilsStripDiacritics2['default'])(labelTest);
				}
				if (_this3.props.ignoreCase) {
					if (_this3.props.matchProp !== 'label') valueTest = valueTest.toLowerCase();
					if (_this3.props.matchProp !== 'value') labelTest = labelTest.toLowerCase();
				}
				return _this3.props.matchPos === 'start' ? _this3.props.matchProp !== 'label' && valueTest.substr(0, filterValue.length) === filterValue || _this3.props.matchProp !== 'value' && labelTest.substr(0, filterValue.length) === filterValue : _this3.props.matchProp !== 'label' && valueTest.indexOf(filterValue) >= 0 || _this3.props.matchProp !== 'value' && labelTest.indexOf(filterValue) >= 0;
			});
		} else {
			return options;
		}
	},

	renderMenu: function renderMenu(options, valueArray, focusedOption) {
		var _this4 = this;

		if (options && options.length) {
			if (this.props.menuRenderer) {
				return this.props.menuRenderer({
					focusedOption: focusedOption,
					focusOption: this.focusOption,
					labelKey: this.props.labelKey,
					options: options,
					selectValue: this.selectValue,
					valueArray: valueArray
				});
			} else {
				var _ret = (function () {
					var Option = _this4.props.optionComponent;
					var renderLabel = _this4.props.optionRenderer || _this4.getOptionLabel;

					return {
						v: options.map(function (option, i) {
							var isSelected = valueArray && valueArray.indexOf(option) > -1;
							var isFocused = option === focusedOption;
							var optionRef = isFocused ? 'focused' : null;
							var optionClass = (0, _classnames2['default'])(_this4.props.optionClassName, {
								'Select-option': true,
								'is-selected': isSelected,
								'is-focused': isFocused,
								'is-disabled': option.disabled
							});

							return _react2['default'].createElement(
								Option,
								{
									className: optionClass,
									isDisabled: option.disabled,
									isFocused: isFocused,
									key: 'option-' + i + '-' + option[_this4.props.valueKey],
									onSelect: _this4.selectValue,
									onFocus: _this4.focusOption,
									option: option,
									isSelected: isSelected,
									ref: optionRef
								},
								renderLabel(option)
							);
						})
					};
				})();

				if (typeof _ret === 'object') return _ret.v;
			}
		} else if (this.props.noResultsText) {
			return _react2['default'].createElement(
				'div',
				{ className: 'Select-noresults' },
				this.props.noResultsText
			);
		} else {
			return null;
		}
	},

	renderHiddenField: function renderHiddenField(valueArray) {
		var _this5 = this;

		if (!this.props.name) return;
		if (this.props.joinValues) {
			var value = valueArray.map(function (i) {
				return stringifyValue(i[_this5.props.valueKey]);
			}).join(this.props.delimiter);
			return _react2['default'].createElement('input', {
				type: 'hidden',
				ref: 'value',
				name: this.props.name,
				value: value,
				disabled: this.props.disabled });
		}
		return valueArray.map(function (item, index) {
			return _react2['default'].createElement('input', { key: 'hidden.' + index,
				type: 'hidden',
				ref: 'value' + index,
				name: _this5.props.name,
				value: stringifyValue(item[_this5.props.valueKey]),
				disabled: _this5.props.disabled });
		});
	},

	getFocusableOption: function getFocusableOption(selectedOption) {
		var options = this._visibleOptions;
		if (!options.length) return;
		var focusedOption = this.state.focusedOption || selectedOption;
		if (focusedOption && options.indexOf(focusedOption) > -1) return focusedOption;
		for (var i = 0; i < options.length; i++) {
			if (!options[i].disabled) return options[i];
		}
	},

	renderOuter: function renderOuter(options, valueArray, focusedOption) {
		var menu = this.renderMenu(options, valueArray, focusedOption);
		if (!menu) {
			return null;
		}

		return _react2['default'].createElement(
			'div',
			{ ref: 'menuContainer', className: 'Select-menu-outer', style: this.props.menuContainerStyle },
			_react2['default'].createElement(
				'div',
				{ ref: 'menu', className: 'Select-menu',
					style: this.props.menuStyle,
					onScroll: this.handleMenuScroll,
					onMouseDown: this.handleMouseDownOnMenu },
				menu
			)
		);
	},

	render: function render() {
		var valueArray = this.getValueArray();
		var options = this._visibleOptions = this.filterOptions(this.props.multi ? valueArray : null);
		var isOpen = this.state.isOpen;
		if (this.props.multi && !options.length && valueArray.length && !this.state.inputValue) isOpen = false;
		var focusedOption = this._focusedOption = this.getFocusableOption(valueArray[0]);
		var className = (0, _classnames2['default'])('Select', this.props.className, {
			'Select--multi': this.props.multi,
			'is-disabled': this.props.disabled,
			'is-focused': this.state.isFocused,
			'is-loading': this.props.isLoading,
			'is-open': isOpen,
			'is-pseudo-focused': this.state.isPseudoFocused,
			'is-searchable': this.props.searchable,
			'has-value': valueArray.length
		});

		return _react2['default'].createElement(
			'div',
			{ ref: 'wrapper', className: className, style: this.props.wrapperStyle },
			this.renderHiddenField(valueArray),
			_react2['default'].createElement(
				'div',
				{ ref: 'control',
					className: 'Select-control',
					style: this.props.style,
					onKeyDown: this.handleKeyDown,
					onMouseDown: this.handleMouseDown,
					onTouchEnd: this.handleTouchEnd,
					onTouchStart: this.handleTouchStart,
					onTouchMove: this.handleTouchMove },
				this.renderValue(valueArray, isOpen),
				this.renderInput(valueArray),
				this.renderLoading(),
				this.renderClear(),
				this.renderArrow()
			),
			isOpen ? this.renderOuter(options, !this.props.multi ? valueArray : null, focusedOption) : null
		);
	}

});

exports['default'] = Select;

var Draggable = (0, _Draggable.DraggableSelect)((0, _reactDnd.DragDropContext)(_reactDndHtml5Backend2['default'])(Select), (0, _Draggable.DraggableValue)(_Value2['default']));

exports.Draggable = Draggable;
exports.DraggableSelect = _Draggable.DraggableSelect;
exports.DraggableValue = _Draggable.DraggableValue;

},{"./Async":211,"./Draggable":212,"./Option":213,"./Value":214,"./utils/stripDiacritics":215,"classnames":undefined,"react":undefined,"react-dnd":190,"react-dnd-html5-backend":98,"react-dom":undefined,"react-input-autosize":undefined}]},{},[])
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLWFzYXAuanMiLCJub2RlX21vZHVsZXMvYXNhcC9icm93c2VyLXJhdy5qcyIsIm5vZGVfbW9kdWxlcy9kaXNwb3NhYmxlcy9tb2R1bGVzL0NvbXBvc2l0ZURpc3Bvc2FibGUuanMiLCJub2RlX21vZHVsZXMvZGlzcG9zYWJsZXMvbW9kdWxlcy9EaXNwb3NhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2Rpc3Bvc2FibGVzL21vZHVsZXMvU2VyaWFsRGlzcG9zYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9kaXNwb3NhYmxlcy9tb2R1bGVzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2Rpc3Bvc2FibGVzL21vZHVsZXMvaXNEaXNwb3NhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi9EcmFnRHJvcE1hbmFnZXIuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbGliL0RyYWdEcm9wTW9uaXRvci5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvRHJhZ1NvdXJjZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvRHJvcFRhcmdldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvSGFuZGxlclJlZ2lzdHJ5LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi9hY3Rpb25zL2RyYWdEcm9wLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi9hY3Rpb25zL3JlZ2lzdHJ5LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi9iYWNrZW5kcy9jcmVhdGVUZXN0QmFja2VuZC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvaW5kZXguanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbGliL3JlZHVjZXJzL2RpcnR5SGFuZGxlcklkcy5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvcmVkdWNlcnMvZHJhZ09mZnNldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvcmVkdWNlcnMvZHJhZ09wZXJhdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9saWIvcmVkdWNlcnMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbGliL3JlZHVjZXJzL3JlZkNvdW50LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi9yZWR1Y2Vycy9zdGF0ZUlkLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL2xpYi91dGlscy9nZXROZXh0VW5pcXVlSWQuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbGliL3V0aWxzL21hdGNoZXNUeXBlLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX0hhc2guanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fTWFwLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX01hcENhY2hlLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX1NldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19TZXRDYWNoZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hcHBseS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hcnJheUZpbHRlci5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hcnJheUluY2x1ZGVzLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2FycmF5SW5jbHVkZXNXaXRoLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2FycmF5TWFwLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2FycmF5UHVzaC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hc3NvY0RlbGV0ZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hc3NvY0dldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hc3NvY0hhcy5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19hc3NvY0luZGV4T2YuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYXNzb2NTZXQuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYmFzZURpZmZlcmVuY2UuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYmFzZUluZGV4T2YuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYmFzZUludGVyc2VjdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19iYXNlUHJvcGVydHkuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYmFzZVVuYXJ5LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2Jhc2VVbmlxLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2Jhc2VYb3IuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fY2FjaGVIYXMuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fY2FjaGVQdXNoLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2Nhc3RBcnJheUxpa2VPYmplY3QuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fY2hlY2tHbG9iYWwuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fY3JlYXRlU2V0LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2dldExlbmd0aC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19nZXROYXRpdmUuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9faGFzaERlbGV0ZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19oYXNoR2V0LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2hhc2hIYXMuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9faGFzaFNldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19pbmRleE9mTmFOLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2lzSG9zdE9iamVjdC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19pc0tleWFibGUuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fbWFwQ2xlYXIuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fbWFwRGVsZXRlLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX21hcEdldC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19tYXBIYXMuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fbWFwU2V0LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX25hdGl2ZUNyZWF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL19yb290LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvX3NldFRvQXJyYXkuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9fdG9Tb3VyY2UuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9lcS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2ludGVyc2VjdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2lzQXJyYXkuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9pc0FycmF5TGlrZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2lzQXJyYXlMaWtlT2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvaXNGdW5jdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2lzTGVuZ3RoLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvaXNOYXRpdmUuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC9pc09iamVjdC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2lzT2JqZWN0TGlrZS5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL2lzU3ltYm9sLmpzIiwibm9kZV9tb2R1bGVzL2RuZC1jb3JlL25vZGVfbW9kdWxlcy9sb2Rhc2gvbm9vcC5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL3Jlc3QuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC90b0ludGVnZXIuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC90b051bWJlci5qcyIsIm5vZGVfbW9kdWxlcy9kbmQtY29yZS9ub2RlX21vZHVsZXMvbG9kYXNoL3dpdGhvdXQuanMiLCJub2RlX21vZHVsZXMvZG5kLWNvcmUvbm9kZV9tb2R1bGVzL2xvZGFzaC94b3IuanMiLCJub2RlX21vZHVsZXMvaW52YXJpYW50L2Jyb3dzZXIuanMiLCJub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL2xpYi9Ccm93c2VyRGV0ZWN0b3IuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbGliL0VudGVyTGVhdmVDb3VudGVyLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL2xpYi9IVE1MNUJhY2tlbmQuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbGliL01vbm90b25pY0ludGVycG9sYW50LmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL2xpYi9OYXRpdmVEcmFnU291cmNlcy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9saWIvTmF0aXZlVHlwZXMuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbGliL09mZnNldFV0aWxzLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL2xpYi9nZXRFbXB0eUltYWdlLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL2xpYi9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9saWIvc2hhbGxvd0VxdWFsLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX1JlZmxlY3QuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9fYXNzaWduSW5EZWZhdWx0cy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19hc3NpZ25WYWx1ZS5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19iYXNlRmxhdHRlbi5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19iYXNlS2V5c0luLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2Jhc2VUaW1lcy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19jb3B5T2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2NyZWF0ZUFzc2lnbmVyLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2luZGV4S2V5cy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19pc0ZsYXR0ZW5hYmxlLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX2lzSW5kZXguanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9faXNJdGVyYXRlZUNhbGwuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9faXNQcm90b3R5cGUuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9faXRlcmF0b3JUb0FycmF5LmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvX3Jvb3QuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9hc3NpZ25JbldpdGguanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9kZWZhdWx0cy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQtaHRtbDUtYmFja2VuZC9ub2RlX21vZHVsZXMvbG9kYXNoL2lzQXJndW1lbnRzLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvaXNTdHJpbmcuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9rZXlzSW4uanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kLWh0bWw1LWJhY2tlbmQvbm9kZV9tb2R1bGVzL2xvZGFzaC9tZW1vaXplLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC1odG1sNS1iYWNrZW5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvdW5pb24uanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9EcmFnRHJvcENvbnRleHQuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9EcmFnTGF5ZXIuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9EcmFnU291cmNlLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvRHJvcFRhcmdldC5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL2FyZU9wdGlvbnNFcXVhbC5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL2NyZWF0ZVNvdXJjZUNvbm5lY3Rvci5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL2NyZWF0ZVNvdXJjZUZhY3RvcnkuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9jcmVhdGVTb3VyY2VNb25pdG9yLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvY3JlYXRlVGFyZ2V0Q29ubmVjdG9yLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvY3JlYXRlVGFyZ2V0RmFjdG9yeS5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL2NyZWF0ZVRhcmdldE1vbml0b3IuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9kZWNvcmF0ZUhhbmRsZXIuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL3JlZ2lzdGVyU291cmNlLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvcmVnaXN0ZXJUYXJnZXQuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL2xpYi91dGlscy9jaGVja0RlY29yYXRvckFyZ3VtZW50cy5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL3V0aWxzL2Nsb25lV2l0aFJlZi5qcyIsIm5vZGVfbW9kdWxlcy9yZWFjdC1kbmQvbGliL3V0aWxzL2lzVmFsaWRUeXBlLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvdXRpbHMvc2hhbGxvd0VxdWFsU2NhbGFyLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9saWIvd3JhcENvbm5lY3Rvckhvb2tzLmpzIiwibm9kZV9tb2R1bGVzL3JlYWN0LWRuZC9ub2RlX21vZHVsZXMvbG9kYXNoL19nZXRQcm90b3R5cGUuanMiLCJub2RlX21vZHVsZXMvcmVhY3QtZG5kL25vZGVfbW9kdWxlcy9sb2Rhc2gvaXNQbGFpbk9iamVjdC5qcyIsIm5vZGVfbW9kdWxlcy9yZWR1eC9saWIvY3JlYXRlU3RvcmUuanMiLCJub2RlX21vZHVsZXMvc3ltYm9sLW9ic2VydmFibGUvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ltYm9sLW9ic2VydmFibGUvcG9ueWZpbGwuanMiLCIvVXNlcnMvc3RlcGhlbm11cnBoeS9TaXRlcy9yZWFjdC1zZWxlY3Qvc3JjL0FzeW5jLmpzIiwiL1VzZXJzL3N0ZXBoZW5tdXJwaHkvU2l0ZXMvcmVhY3Qtc2VsZWN0L3NyYy9EcmFnZ2FibGUuanMiLCIvVXNlcnMvc3RlcGhlbm11cnBoeS9TaXRlcy9yZWFjdC1zZWxlY3Qvc3JjL09wdGlvbi5qcyIsIi9Vc2Vycy9zdGVwaGVubXVycGh5L1NpdGVzL3JlYWN0LXNlbGVjdC9zcmMvVmFsdWUuanMiLCIvVXNlcnMvc3RlcGhlbm11cnBoeS9TaXRlcy9yZWFjdC1zZWxlY3Qvc3JjL3V0aWxzL3N0cmlwRGlhY3JpdGljcy5qcyIsIi9Vc2Vycy9zdGVwaGVubXVycGh5L1NpdGVzL3JlYWN0LXNlbGVjdC9zcmMvU2VsZWN0LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ2xFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDNU5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM01BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25NQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25FQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNkQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNkQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3pDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQzNCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ25EQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9qQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0dBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7Ozs7O0FDbkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7Ozs7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7OztBQzNCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN0Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNwQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7Ozs7Ozs7OztBQ3JDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQzlCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7Ozs7Ozs7Ozs7OztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7Ozs7O0FDekNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FDOUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7Ozs7OztBQ3pFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMxQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUN4RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDdEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDN0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNsRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3BGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ3RCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7OztBQ2ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FB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O0FBQ2xDLGVBQVUsRUFBRSxJQUFJLENBQUMsY0FBYyxBQUFDO0FBQ2hDLGlCQUFZLEVBQUUsSUFBSSxDQUFDLGdCQUFnQixBQUFDO0FBQ3BDLGdCQUFXLEVBQUUsSUFBSSxDQUFDLGVBQWUsQUFBQztJQUNuQyxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsRUFBRSxNQUFNLENBQUM7SUFDcEMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxVQUFVLENBQUM7SUFDNUIsSUFBSSxDQUFDLGFBQWEsRUFBRTtJQUNwQixJQUFJLENBQUMsV0FBVyxFQUFFO0lBQ2xCLElBQUksQ0FBQyxXQUFXLEVBQUU7SUFDZDtHQUNMLE1BQU0sR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLFVBQVUsR0FBRyxJQUFJLEVBQUUsYUFBYSxDQUFDLEdBQUcsSUFBSTtHQUMzRixDQUNMO0VBQ0Y7O0NBRUQsQ0FBQyxDQUFDOztxQkFFWSxNQUFNOztBQUVyQixJQUFJLFNBQVMsR0FBRyxnQ0FDZCxpRUFBNkIsQ0FBQyxNQUFNLENBQUMsRUFDckMsa0RBQXFCLENBQ3RCLENBQUM7O1FBRU0sU0FBUyxHQUFULFNBQVM7UUFBRSxlQUFlO1FBQUUsY0FBYyIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJcInVzZSBzdHJpY3RcIjtcblxuLy8gcmF3QXNhcCBwcm92aWRlcyBldmVyeXRoaW5nIHdlIG5lZWQgZXhjZXB0IGV4Y2VwdGlvbiBtYW5hZ2VtZW50LlxudmFyIHJhd0FzYXAgPSByZXF1aXJlKFwiLi9yYXdcIik7XG4vLyBSYXdUYXNrcyBhcmUgcmVjeWNsZWQgdG8gcmVkdWNlIEdDIGNodXJuLlxudmFyIGZyZWVUYXNrcyA9IFtdO1xuLy8gV2UgcXVldWUgZXJyb3JzIHRvIGVuc3VyZSB0aGV5IGFyZSB0aHJvd24gaW4gcmlnaHQgb3JkZXIgKEZJRk8pLlxuLy8gQXJyYXktYXMtcXVldWUgaXMgZ29vZCBlbm91Z2ggaGVyZSwgc2luY2Ugd2UgYXJlIGp1c3QgZGVhbGluZyB3aXRoIGV4Y2VwdGlvbnMuXG52YXIgcGVuZGluZ0Vycm9ycyA9IFtdO1xudmFyIHJlcXVlc3RFcnJvclRocm93ID0gcmF3QXNhcC5tYWtlUmVxdWVzdENhbGxGcm9tVGltZXIodGhyb3dGaXJzdEVycm9yKTtcblxuZnVuY3Rpb24gdGhyb3dGaXJzdEVycm9yKCkge1xuICAgIGlmIChwZW5kaW5nRXJyb3JzLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBwZW5kaW5nRXJyb3JzLnNoaWZ0KCk7XG4gICAgfVxufVxuXG4vKipcbiAqIENhbGxzIGEgdGFzayBhcyBzb29uIGFzIHBvc3NpYmxlIGFmdGVyIHJldHVybmluZywgaW4gaXRzIG93biBldmVudCwgd2l0aCBwcmlvcml0eVxuICogb3ZlciBvdGhlciBldmVudHMgbGlrZSBhbmltYXRpb24sIHJlZmxvdywgYW5kIHJlcGFpbnQuIEFuIGVycm9yIHRocm93biBmcm9tIGFuXG4gKiBldmVudCB3aWxsIG5vdCBpbnRlcnJ1cHQsIG5vciBldmVuIHN1YnN0YW50aWFsbHkgc2xvdyBkb3duIHRoZSBwcm9jZXNzaW5nIG9mXG4gKiBvdGhlciBldmVudHMsIGJ1dCB3aWxsIGJlIHJhdGhlciBwb3N0cG9uZWQgdG8gYSBsb3dlciBwcmlvcml0eSBldmVudC5cbiAqIEBwYXJhbSB7e2NhbGx9fSB0YXNrIEEgY2FsbGFibGUgb2JqZWN0LCB0eXBpY2FsbHkgYSBmdW5jdGlvbiB0aGF0IHRha2VzIG5vXG4gKiBhcmd1bWVudHMuXG4gKi9cbm1vZHVsZS5leHBvcnRzID0gYXNhcDtcbmZ1bmN0aW9uIGFzYXAodGFzaykge1xuICAgIHZhciByYXdUYXNrO1xuICAgIGlmIChmcmVlVGFza3MubGVuZ3RoKSB7XG4gICAgICAgIHJhd1Rhc2sgPSBmcmVlVGFza3MucG9wKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmF3VGFzayA9IG5ldyBSYXdUYXNrKCk7XG4gICAgfVxuICAgIHJhd1Rhc2sudGFzayA9IHRhc2s7XG4gICAgcmF3QXNhcChyYXdUYXNrKTtcbn1cblxuLy8gV2Ugd3JhcCB0YXNrcyB3aXRoIHJlY3ljbGFibGUgdGFzayBvYmplY3RzLiAgQSB0YXNrIG9iamVjdCBpbXBsZW1lbnRzXG4vLyBgY2FsbGAsIGp1c3QgbGlrZSBhIGZ1bmN0aW9uLlxuZnVuY3Rpb24gUmF3VGFzaygpIHtcbiAgICB0aGlzLnRhc2sgPSBudWxsO1xufVxuXG4vLyBUaGUgc29sZSBwdXJwb3NlIG9mIHdyYXBwaW5nIHRoZSB0YXNrIGlzIHRvIGNhdGNoIHRoZSBleGNlcHRpb24gYW5kIHJlY3ljbGVcbi8vIHRoZSB0YXNrIG9iamVjdCBhZnRlciBpdHMgc2luZ2xlIHVzZS5cblJhd1Rhc2sucHJvdG90eXBlLmNhbGwgPSBmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgdGhpcy50YXNrLmNhbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoYXNhcC5vbmVycm9yKSB7XG4gICAgICAgICAgICAvLyBUaGlzIGhvb2sgZXhpc3RzIHB1cmVseSBmb3IgdGVzdGluZyBwdXJwb3Nlcy5cbiAgICAgICAgICAgIC8vIEl0cyBuYW1lIHdpbGwgYmUgcGVyaW9kaWNhbGx5IHJhbmRvbWl6ZWQgdG8gYnJlYWsgYW55IGNvZGUgdGhhdFxuICAgICAgICAgICAgLy8gZGVwZW5kcyBvbiBpdHMgZXhpc3RlbmNlLlxuICAgICAgICAgICAgYXNhcC5vbmVycm9yKGVycm9yKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEluIGEgd2ViIGJyb3dzZXIsIGV4Y2VwdGlvbnMgYXJlIG5vdCBmYXRhbC4gSG93ZXZlciwgdG8gYXZvaWRcbiAgICAgICAgICAgIC8vIHNsb3dpbmcgZG93biB0aGUgcXVldWUgb2YgcGVuZGluZyB0YXNrcywgd2UgcmV0aHJvdyB0aGUgZXJyb3IgaW4gYVxuICAgICAgICAgICAgLy8gbG93ZXIgcHJpb3JpdHkgdHVybi5cbiAgICAgICAgICAgIHBlbmRpbmdFcnJvcnMucHVzaChlcnJvcik7XG4gICAgICAgICAgICByZXF1ZXN0RXJyb3JUaHJvdygpO1xuICAgICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdGhpcy50YXNrID0gbnVsbDtcbiAgICAgICAgZnJlZVRhc2tzW2ZyZWVUYXNrcy5sZW5ndGhdID0gdGhpcztcbiAgICB9XG59O1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8vIFVzZSB0aGUgZmFzdGVzdCBtZWFucyBwb3NzaWJsZSB0byBleGVjdXRlIGEgdGFzayBpbiBpdHMgb3duIHR1cm4sIHdpdGhcbi8vIHByaW9yaXR5IG92ZXIgb3RoZXIgZXZlbnRzIGluY2x1ZGluZyBJTywgYW5pbWF0aW9uLCByZWZsb3csIGFuZCByZWRyYXdcbi8vIGV2ZW50cyBpbiBicm93c2Vycy5cbi8vXG4vLyBBbiBleGNlcHRpb24gdGhyb3duIGJ5IGEgdGFzayB3aWxsIHBlcm1hbmVudGx5IGludGVycnVwdCB0aGUgcHJvY2Vzc2luZyBvZlxuLy8gc3Vic2VxdWVudCB0YXNrcy4gVGhlIGhpZ2hlciBsZXZlbCBgYXNhcGAgZnVuY3Rpb24gZW5zdXJlcyB0aGF0IGlmIGFuXG4vLyBleGNlcHRpb24gaXMgdGhyb3duIGJ5IGEgdGFzaywgdGhhdCB0aGUgdGFzayBxdWV1ZSB3aWxsIGNvbnRpbnVlIGZsdXNoaW5nIGFzXG4vLyBzb29uIGFzIHBvc3NpYmxlLCBidXQgaWYgeW91IHVzZSBgcmF3QXNhcGAgZGlyZWN0bHksIHlvdSBhcmUgcmVzcG9uc2libGUgdG9cbi8vIGVpdGhlciBlbnN1cmUgdGhhdCBubyBleGNlcHRpb25zIGFyZSB0aHJvd24gZnJvbSB5b3VyIHRhc2ssIG9yIHRvIG1hbnVhbGx5XG4vLyBjYWxsIGByYXdBc2FwLnJlcXVlc3RGbHVzaGAgaWYgYW4gZXhjZXB0aW9uIGlzIHRocm93bi5cbm1vZHVsZS5leHBvcnRzID0gcmF3QXNhcDtcbmZ1bmN0aW9uIHJhd0FzYXAodGFzaykge1xuICAgIGlmICghcXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHJlcXVlc3RGbHVzaCgpO1xuICAgICAgICBmbHVzaGluZyA9IHRydWU7XG4gICAgfVxuICAgIC8vIEVxdWl2YWxlbnQgdG8gcHVzaCwgYnV0IGF2b2lkcyBhIGZ1bmN0aW9uIGNhbGwuXG4gICAgcXVldWVbcXVldWUubGVuZ3RoXSA9IHRhc2s7XG59XG5cbnZhciBxdWV1ZSA9IFtdO1xuLy8gT25jZSBhIGZsdXNoIGhhcyBiZWVuIHJlcXVlc3RlZCwgbm8gZnVydGhlciBjYWxscyB0byBgcmVxdWVzdEZsdXNoYCBhcmVcbi8vIG5lY2Vzc2FyeSB1bnRpbCB0aGUgbmV4dCBgZmx1c2hgIGNvbXBsZXRlcy5cbnZhciBmbHVzaGluZyA9IGZhbHNlO1xuLy8gYHJlcXVlc3RGbHVzaGAgaXMgYW4gaW1wbGVtZW50YXRpb24tc3BlY2lmaWMgbWV0aG9kIHRoYXQgYXR0ZW1wdHMgdG8ga2lja1xuLy8gb2ZmIGEgYGZsdXNoYCBldmVudCBhcyBxdWlja2x5IGFzIHBvc3NpYmxlLiBgZmx1c2hgIHdpbGwgYXR0ZW1wdCB0byBleGhhdXN0XG4vLyB0aGUgZXZlbnQgcXVldWUgYmVmb3JlIHlpZWxkaW5nIHRvIHRoZSBicm93c2VyJ3Mgb3duIGV2ZW50IGxvb3AuXG52YXIgcmVxdWVzdEZsdXNoO1xuLy8gVGhlIHBvc2l0aW9uIG9mIHRoZSBuZXh0IHRhc2sgdG8gZXhlY3V0ZSBpbiB0aGUgdGFzayBxdWV1ZS4gVGhpcyBpc1xuLy8gcHJlc2VydmVkIGJldHdlZW4gY2FsbHMgdG8gYGZsdXNoYCBzbyB0aGF0IGl0IGNhbiBiZSByZXN1bWVkIGlmXG4vLyBhIHRhc2sgdGhyb3dzIGFuIGV4Y2VwdGlvbi5cbnZhciBpbmRleCA9IDA7XG4vLyBJZiBhIHRhc2sgc2NoZWR1bGVzIGFkZGl0aW9uYWwgdGFza3MgcmVjdXJzaXZlbHksIHRoZSB0YXNrIHF1ZXVlIGNhbiBncm93XG4vLyB1bmJvdW5kZWQuIFRvIHByZXZlbnQgbWVtb3J5IGV4aGF1c3Rpb24sIHRoZSB0YXNrIHF1ZXVlIHdpbGwgcGVyaW9kaWNhbGx5XG4vLyB0cnVuY2F0ZSBhbHJlYWR5LWNvbXBsZXRlZCB0YXNrcy5cbnZhciBjYXBhY2l0eSA9IDEwMjQ7XG5cbi8vIFRoZSBmbHVzaCBmdW5jdGlvbiBwcm9jZXNzZXMgYWxsIHRhc2tzIHRoYXQgaGF2ZSBiZWVuIHNjaGVkdWxlZCB3aXRoXG4vLyBgcmF3QXNhcGAgdW5sZXNzIGFuZCB1bnRpbCBvbmUgb2YgdGhvc2UgdGFza3MgdGhyb3dzIGFuIGV4Y2VwdGlvbi5cbi8vIElmIGEgdGFzayB0aHJvd3MgYW4gZXhjZXB0aW9uLCBgZmx1c2hgIGVuc3VyZXMgdGhhdCBpdHMgc3RhdGUgd2lsbCByZW1haW5cbi8vIGNvbnNpc3RlbnQgYW5kIHdpbGwgcmVzdW1lIHdoZXJlIGl0IGxlZnQgb2ZmIHdoZW4gY2FsbGVkIGFnYWluLlxuLy8gSG93ZXZlciwgYGZsdXNoYCBkb2VzIG5vdCBtYWtlIGFueSBhcnJhbmdlbWVudHMgdG8gYmUgY2FsbGVkIGFnYWluIGlmIGFuXG4vLyBleGNlcHRpb24gaXMgdGhyb3duLlxuZnVuY3Rpb24gZmx1c2goKSB7XG4gICAgd2hpbGUgKGluZGV4IDwgcXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHZhciBjdXJyZW50SW5kZXggPSBpbmRleDtcbiAgICAgICAgLy8gQWR2YW5jZSB0aGUgaW5kZXggYmVmb3JlIGNhbGxpbmcgdGhlIHRhc2suIFRoaXMgZW5zdXJlcyB0aGF0IHdlIHdpbGxcbiAgICAgICAgLy8gYmVnaW4gZmx1c2hpbmcgb24gdGhlIG5leHQgdGFzayB0aGUgdGFzayB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICAgIGluZGV4ID0gaW5kZXggKyAxO1xuICAgICAgICBxdWV1ZVtjdXJyZW50SW5kZXhdLmNhbGwoKTtcbiAgICAgICAgLy8gUHJldmVudCBsZWFraW5nIG1lbW9yeSBmb3IgbG9uZyBjaGFpbnMgb2YgcmVjdXJzaXZlIGNhbGxzIHRvIGBhc2FwYC5cbiAgICAgICAgLy8gSWYgd2UgY2FsbCBgYXNhcGAgd2l0aGluIHRhc2tzIHNjaGVkdWxlZCBieSBgYXNhcGAsIHRoZSBxdWV1ZSB3aWxsXG4gICAgICAgIC8vIGdyb3csIGJ1dCB0byBhdm9pZCBhbiBPKG4pIHdhbGsgZm9yIGV2ZXJ5IHRhc2sgd2UgZXhlY3V0ZSwgd2UgZG9uJ3RcbiAgICAgICAgLy8gc2hpZnQgdGFza3Mgb2ZmIHRoZSBxdWV1ZSBhZnRlciB0aGV5IGhhdmUgYmVlbiBleGVjdXRlZC5cbiAgICAgICAgLy8gSW5zdGVhZCwgd2UgcGVyaW9kaWNhbGx5IHNoaWZ0IDEwMjQgdGFza3Mgb2ZmIHRoZSBxdWV1ZS5cbiAgICAgICAgaWYgKGluZGV4ID4gY2FwYWNpdHkpIHtcbiAgICAgICAgICAgIC8vIE1hbnVhbGx5IHNoaWZ0IGFsbCB2YWx1ZXMgc3RhcnRpbmcgYXQgdGhlIGluZGV4IGJhY2sgdG8gdGhlXG4gICAgICAgICAgICAvLyBiZWdpbm5pbmcgb2YgdGhlIHF1ZXVlLlxuICAgICAgICAgICAgZm9yICh2YXIgc2NhbiA9IDAsIG5ld0xlbmd0aCA9IHF1ZXVlLmxlbmd0aCAtIGluZGV4OyBzY2FuIDwgbmV3TGVuZ3RoOyBzY2FuKyspIHtcbiAgICAgICAgICAgICAgICBxdWV1ZVtzY2FuXSA9IHF1ZXVlW3NjYW4gKyBpbmRleF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBxdWV1ZS5sZW5ndGggLT0gaW5kZXg7XG4gICAgICAgICAgICBpbmRleCA9IDA7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUubGVuZ3RoID0gMDtcbiAgICBpbmRleCA9IDA7XG4gICAgZmx1c2hpbmcgPSBmYWxzZTtcbn1cblxuLy8gYHJlcXVlc3RGbHVzaGAgaXMgaW1wbGVtZW50ZWQgdXNpbmcgYSBzdHJhdGVneSBiYXNlZCBvbiBkYXRhIGNvbGxlY3RlZCBmcm9tXG4vLyBldmVyeSBhdmFpbGFibGUgU2F1Y2VMYWJzIFNlbGVuaXVtIHdlYiBkcml2ZXIgd29ya2VyIGF0IHRpbWUgb2Ygd3JpdGluZy5cbi8vIGh0dHBzOi8vZG9jcy5nb29nbGUuY29tL3NwcmVhZHNoZWV0cy9kLzFtRy01VVlHdXA1cXhHZEVNV2toUDZCV0N6MDUzTlViMkUxUW9VVFUxNnVBL2VkaXQjZ2lkPTc4MzcyNDU5M1xuXG4vLyBTYWZhcmkgNiBhbmQgNi4xIGZvciBkZXNrdG9wLCBpUGFkLCBhbmQgaVBob25lIGFyZSB0aGUgb25seSBicm93c2VycyB0aGF0XG4vLyBoYXZlIFdlYktpdE11dGF0aW9uT2JzZXJ2ZXIgYnV0IG5vdCB1bi1wcmVmaXhlZCBNdXRhdGlvbk9ic2VydmVyLlxuLy8gTXVzdCB1c2UgYGdsb2JhbGAgaW5zdGVhZCBvZiBgd2luZG93YCB0byB3b3JrIGluIGJvdGggZnJhbWVzIGFuZCB3ZWJcbi8vIHdvcmtlcnMuIGBnbG9iYWxgIGlzIGEgcHJvdmlzaW9uIG9mIEJyb3dzZXJpZnksIE1yLCBNcnMsIG9yIE1vcC5cbnZhciBCcm93c2VyTXV0YXRpb25PYnNlcnZlciA9IGdsb2JhbC5NdXRhdGlvbk9ic2VydmVyIHx8IGdsb2JhbC5XZWJLaXRNdXRhdGlvbk9ic2VydmVyO1xuXG4vLyBNdXRhdGlvbk9ic2VydmVycyBhcmUgZGVzaXJhYmxlIGJlY2F1c2UgdGhleSBoYXZlIGhpZ2ggcHJpb3JpdHkgYW5kIHdvcmtcbi8vIHJlbGlhYmx5IGV2ZXJ5d2hlcmUgdGhleSBhcmUgaW1wbGVtZW50ZWQuXG4vLyBUaGV5IGFyZSBpbXBsZW1lbnRlZCBpbiBhbGwgbW9kZXJuIGJyb3dzZXJzLlxuLy9cbi8vIC0gQW5kcm9pZCA0LTQuM1xuLy8gLSBDaHJvbWUgMjYtMzRcbi8vIC0gRmlyZWZveCAxNC0yOVxuLy8gLSBJbnRlcm5ldCBFeHBsb3JlciAxMVxuLy8gLSBpUGFkIFNhZmFyaSA2LTcuMVxuLy8gLSBpUGhvbmUgU2FmYXJpIDctNy4xXG4vLyAtIFNhZmFyaSA2LTdcbmlmICh0eXBlb2YgQnJvd3Nlck11dGF0aW9uT2JzZXJ2ZXIgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHJlcXVlc3RGbHVzaCA9IG1ha2VSZXF1ZXN0Q2FsbEZyb21NdXRhdGlvbk9ic2VydmVyKGZsdXNoKTtcblxuLy8gTWVzc2FnZUNoYW5uZWxzIGFyZSBkZXNpcmFibGUgYmVjYXVzZSB0aGV5IGdpdmUgZGlyZWN0IGFjY2VzcyB0byB0aGUgSFRNTFxuLy8gdGFzayBxdWV1ZSwgYXJlIGltcGxlbWVudGVkIGluIEludGVybmV0IEV4cGxvcmVyIDEwLCBTYWZhcmkgNS4wLTEsIGFuZCBPcGVyYVxuLy8gMTEtMTIsIGFuZCBpbiB3ZWIgd29ya2VycyBpbiBtYW55IGVuZ2luZXMuXG4vLyBBbHRob3VnaCBtZXNzYWdlIGNoYW5uZWxzIHlpZWxkIHRvIGFueSBxdWV1ZWQgcmVuZGVyaW5nIGFuZCBJTyB0YXNrcywgdGhleVxuLy8gd291bGQgYmUgYmV0dGVyIHRoYW4gaW1wb3NpbmcgdGhlIDRtcyBkZWxheSBvZiB0aW1lcnMuXG4vLyBIb3dldmVyLCB0aGV5IGRvIG5vdCB3b3JrIHJlbGlhYmx5IGluIEludGVybmV0IEV4cGxvcmVyIG9yIFNhZmFyaS5cblxuLy8gSW50ZXJuZXQgRXhwbG9yZXIgMTAgaXMgdGhlIG9ubHkgYnJvd3NlciB0aGF0IGhhcyBzZXRJbW1lZGlhdGUgYnV0IGRvZXNcbi8vIG5vdCBoYXZlIE11dGF0aW9uT2JzZXJ2ZXJzLlxuLy8gQWx0aG91Z2ggc2V0SW1tZWRpYXRlIHlpZWxkcyB0byB0aGUgYnJvd3NlcidzIHJlbmRlcmVyLCBpdCB3b3VsZCBiZVxuLy8gcHJlZmVycmFibGUgdG8gZmFsbGluZyBiYWNrIHRvIHNldFRpbWVvdXQgc2luY2UgaXQgZG9lcyBub3QgaGF2ZVxuLy8gdGhlIG1pbmltdW0gNG1zIHBlbmFsdHkuXG4vLyBVbmZvcnR1bmF0ZWx5IHRoZXJlIGFwcGVhcnMgdG8gYmUgYSBidWcgaW4gSW50ZXJuZXQgRXhwbG9yZXIgMTAgTW9iaWxlIChhbmRcbi8vIERlc2t0b3AgdG8gYSBsZXNzZXIgZXh0ZW50KSB0aGF0IHJlbmRlcnMgYm90aCBzZXRJbW1lZGlhdGUgYW5kXG4vLyBNZXNzYWdlQ2hhbm5lbCB1c2VsZXNzIGZvciB0aGUgcHVycG9zZXMgb2YgQVNBUC5cbi8vIGh0dHBzOi8vZ2l0aHViLmNvbS9rcmlza293YWwvcS9pc3N1ZXMvMzk2XG5cbi8vIFRpbWVycyBhcmUgaW1wbGVtZW50ZWQgdW5pdmVyc2FsbHkuXG4vLyBXZSBmYWxsIGJhY2sgdG8gdGltZXJzIGluIHdvcmtlcnMgaW4gbW9zdCBlbmdpbmVzLCBhbmQgaW4gZm9yZWdyb3VuZFxuLy8gY29udGV4dHMgaW4gdGhlIGZvbGxvd2luZyBicm93c2Vycy5cbi8vIEhvd2V2ZXIsIG5vdGUgdGhhdCBldmVuIHRoaXMgc2ltcGxlIGNhc2UgcmVxdWlyZXMgbnVhbmNlcyB0byBvcGVyYXRlIGluIGFcbi8vIGJyb2FkIHNwZWN0cnVtIG9mIGJyb3dzZXJzLlxuLy9cbi8vIC0gRmlyZWZveCAzLTEzXG4vLyAtIEludGVybmV0IEV4cGxvcmVyIDYtOVxuLy8gLSBpUGFkIFNhZmFyaSA0LjNcbi8vIC0gTHlueCAyLjguN1xufSBlbHNlIHtcbiAgICByZXF1ZXN0Rmx1c2ggPSBtYWtlUmVxdWVzdENhbGxGcm9tVGltZXIoZmx1c2gpO1xufVxuXG4vLyBgcmVxdWVzdEZsdXNoYCByZXF1ZXN0cyB0aGF0IHRoZSBoaWdoIHByaW9yaXR5IGV2ZW50IHF1ZXVlIGJlIGZsdXNoZWQgYXNcbi8vIHNvb24gYXMgcG9zc2libGUuXG4vLyBUaGlzIGlzIHVzZWZ1bCB0byBwcmV2ZW50IGFuIGVycm9yIHRocm93biBpbiBhIHRhc2sgZnJvbSBzdGFsbGluZyB0aGUgZXZlbnRcbi8vIHF1ZXVlIGlmIHRoZSBleGNlcHRpb24gaGFuZGxlZCBieSBOb2RlLmpz4oCZc1xuLy8gYHByb2Nlc3Mub24oXCJ1bmNhdWdodEV4Y2VwdGlvblwiKWAgb3IgYnkgYSBkb21haW4uXG5yYXdBc2FwLnJlcXVlc3RGbHVzaCA9IHJlcXVlc3RGbHVzaDtcblxuLy8gVG8gcmVxdWVzdCBhIGhpZ2ggcHJpb3JpdHkgZXZlbnQsIHdlIGluZHVjZSBhIG11dGF0aW9uIG9ic2VydmVyIGJ5IHRvZ2dsaW5nXG4vLyB0aGUgdGV4dCBvZiBhIHRleHQgbm9kZSBiZXR3ZWVuIFwiMVwiIGFuZCBcIi0xXCIuXG5mdW5jdGlvbiBtYWtlUmVxdWVzdENhbGxGcm9tTXV0YXRpb25PYnNlcnZlcihjYWxsYmFjaykge1xuICAgIHZhciB0b2dnbGUgPSAxO1xuICAgIHZhciBvYnNlcnZlciA9IG5ldyBCcm93c2VyTXV0YXRpb25PYnNlcnZlcihjYWxsYmFjayk7XG4gICAgdmFyIG5vZGUgPSBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcIlwiKTtcbiAgICBvYnNlcnZlci5vYnNlcnZlKG5vZGUsIHtjaGFyYWN0ZXJEYXRhOiB0cnVlfSk7XG4gICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuICAgICAgICB0b2dnbGUgPSAtdG9nZ2xlO1xuICAgICAgICBub2RlLmRhdGEgPSB0b2dnbGU7XG4gICAgfTtcbn1cblxuLy8gVGhlIG1lc3NhZ2UgY2hhbm5lbCB0ZWNobmlxdWUgd2FzIGRpc2NvdmVyZWQgYnkgTWFsdGUgVWJsIGFuZCB3YXMgdGhlXG4vLyBvcmlnaW5hbCBmb3VuZGF0aW9uIGZvciB0aGlzIGxpYnJhcnkuXG4vLyBodHRwOi8vd3d3Lm5vbmJsb2NraW5nLmlvLzIwMTEvMDYvd2luZG93bmV4dHRpY2suaHRtbFxuXG4vLyBTYWZhcmkgNi4wLjUgKGF0IGxlYXN0KSBpbnRlcm1pdHRlbnRseSBmYWlscyB0byBjcmVhdGUgbWVzc2FnZSBwb3J0cyBvbiBhXG4vLyBwYWdlJ3MgZmlyc3QgbG9hZC4gVGhhbmtmdWxseSwgdGhpcyB2ZXJzaW9uIG9mIFNhZmFyaSBzdXBwb3J0c1xuLy8gTXV0YXRpb25PYnNlcnZlcnMsIHNvIHdlIGRvbid0IG5lZWQgdG8gZmFsbCBiYWNrIGluIHRoYXQgY2FzZS5cblxuLy8gZnVuY3Rpb24gbWFrZVJlcXVlc3RDYWxsRnJvbU1lc3NhZ2VDaGFubmVsKGNhbGxiYWNrKSB7XG4vLyAgICAgdmFyIGNoYW5uZWwgPSBuZXcgTWVzc2FnZUNoYW5uZWwoKTtcbi8vICAgICBjaGFubmVsLnBvcnQxLm9ubWVzc2FnZSA9IGNhbGxiYWNrO1xuLy8gICAgIHJldHVybiBmdW5jdGlvbiByZXF1ZXN0Q2FsbCgpIHtcbi8vICAgICAgICAgY2hhbm5lbC5wb3J0Mi5wb3N0TWVzc2FnZSgwKTtcbi8vICAgICB9O1xuLy8gfVxuXG4vLyBGb3IgcmVhc29ucyBleHBsYWluZWQgYWJvdmUsIHdlIGFyZSBhbHNvIHVuYWJsZSB0byB1c2UgYHNldEltbWVkaWF0ZWBcbi8vIHVuZGVyIGFueSBjaXJjdW1zdGFuY2VzLlxuLy8gRXZlbiBpZiB3ZSB3ZXJlLCB0aGVyZSBpcyBhbm90aGVyIGJ1ZyBpbiBJbnRlcm5ldCBFeHBsb3JlciAxMC5cbi8vIEl0IGlzIG5vdCBzdWZmaWNpZW50IHRvIGFzc2lnbiBgc2V0SW1tZWRpYXRlYCB0byBgcmVxdWVzdEZsdXNoYCBiZWNhdXNlXG4vLyBgc2V0SW1tZWRpYXRlYCBtdXN0IGJlIGNhbGxlZCAqYnkgbmFtZSogYW5kIHRoZXJlZm9yZSBtdXN0IGJlIHdyYXBwZWQgaW4gYVxuLy8gY2xvc3VyZS5cbi8vIE5ldmVyIGZvcmdldC5cblxuLy8gZnVuY3Rpb24gbWFrZVJlcXVlc3RDYWxsRnJvbVNldEltbWVkaWF0ZShjYWxsYmFjaykge1xuLy8gICAgIHJldHVybiBmdW5jdGlvbiByZXF1ZXN0Q2FsbCgpIHtcbi8vICAgICAgICAgc2V0SW1tZWRpYXRlKGNhbGxiYWNrKTtcbi8vICAgICB9O1xuLy8gfVxuXG4vLyBTYWZhcmkgNi4wIGhhcyBhIHByb2JsZW0gd2hlcmUgdGltZXJzIHdpbGwgZ2V0IGxvc3Qgd2hpbGUgdGhlIHVzZXIgaXNcbi8vIHNjcm9sbGluZy4gVGhpcyBwcm9ibGVtIGRvZXMgbm90IGltcGFjdCBBU0FQIGJlY2F1c2UgU2FmYXJpIDYuMCBzdXBwb3J0c1xuLy8gbXV0YXRpb24gb2JzZXJ2ZXJzLCBzbyB0aGF0IGltcGxlbWVudGF0aW9uIGlzIHVzZWQgaW5zdGVhZC5cbi8vIEhvd2V2ZXIsIGlmIHdlIGV2ZXIgZWxlY3QgdG8gdXNlIHRpbWVycyBpbiBTYWZhcmksIHRoZSBwcmV2YWxlbnQgd29yay1hcm91bmRcbi8vIGlzIHRvIGFkZCBhIHNjcm9sbCBldmVudCBsaXN0ZW5lciB0aGF0IGNhbGxzIGZvciBhIGZsdXNoLlxuXG4vLyBgc2V0VGltZW91dGAgZG9lcyBub3QgY2FsbCB0aGUgcGFzc2VkIGNhbGxiYWNrIGlmIHRoZSBkZWxheSBpcyBsZXNzIHRoYW5cbi8vIGFwcHJveGltYXRlbHkgNyBpbiB3ZWIgd29ya2VycyBpbiBGaXJlZm94IDggdGhyb3VnaCAxOCwgYW5kIHNvbWV0aW1lcyBub3Rcbi8vIGV2ZW4gdGhlbi5cblxuZnVuY3Rpb24gbWFrZVJlcXVlc3RDYWxsRnJvbVRpbWVyKGNhbGxiYWNrKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uIHJlcXVlc3RDYWxsKCkge1xuICAgICAgICAvLyBXZSBkaXNwYXRjaCBhIHRpbWVvdXQgd2l0aCBhIHNwZWNpZmllZCBkZWxheSBvZiAwIGZvciBlbmdpbmVzIHRoYXRcbiAgICAgICAgLy8gY2FuIHJlbGlhYmx5IGFjY29tbW9kYXRlIHRoYXQgcmVxdWVzdC4gVGhpcyB3aWxsIHVzdWFsbHkgYmUgc25hcHBlZFxuICAgICAgICAvLyB0byBhIDQgbWlsaXNlY29uZCBkZWxheSwgYnV0IG9uY2Ugd2UncmUgZmx1c2hpbmcsIHRoZXJlJ3Mgbm8gZGVsYXlcbiAgICAgICAgLy8gYmV0d2VlbiBldmVudHMuXG4gICAgICAgIHZhciB0aW1lb3V0SGFuZGxlID0gc2V0VGltZW91dChoYW5kbGVUaW1lciwgMCk7XG4gICAgICAgIC8vIEhvd2V2ZXIsIHNpbmNlIHRoaXMgdGltZXIgZ2V0cyBmcmVxdWVudGx5IGRyb3BwZWQgaW4gRmlyZWZveFxuICAgICAgICAvLyB3b3JrZXJzLCB3ZSBlbmxpc3QgYW4gaW50ZXJ2YWwgaGFuZGxlIHRoYXQgd2lsbCB0cnkgdG8gZmlyZVxuICAgICAgICAvLyBhbiBldmVudCAyMCB0aW1lcyBwZXIgc2Vjb25kIHVudGlsIGl0IHN1Y2NlZWRzLlxuICAgICAgICB2YXIgaW50ZXJ2YWxIYW5kbGUgPSBzZXRJbnRlcnZhbChoYW5kbGVUaW1lciwgNTApO1xuXG4gICAgICAgIGZ1bmN0aW9uIGhhbmRsZVRpbWVyKCkge1xuICAgICAgICAgICAgLy8gV2hpY2hldmVyIHRpbWVyIHN1Y2NlZWRzIHdpbGwgY2FuY2VsIGJvdGggdGltZXJzIGFuZFxuICAgICAgICAgICAgLy8gZXhlY3V0ZSB0aGUgY2FsbGJhY2suXG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dEhhbmRsZSk7XG4gICAgICAgICAgICBjbGVhckludGVydmFsKGludGVydmFsSGFuZGxlKTtcbiAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIH1cbiAgICB9O1xufVxuXG4vLyBUaGlzIGlzIGZvciBgYXNhcC5qc2Agb25seS5cbi8vIEl0cyBuYW1lIHdpbGwgYmUgcGVyaW9kaWNhbGx5IHJhbmRvbWl6ZWQgdG8gYnJlYWsgYW55IGNvZGUgdGhhdCBkZXBlbmRzIG9uXG4vLyBpdHMgZXhpc3RlbmNlLlxucmF3QXNhcC5tYWtlUmVxdWVzdENhbGxGcm9tVGltZXIgPSBtYWtlUmVxdWVzdENhbGxGcm9tVGltZXI7XG5cbi8vIEFTQVAgd2FzIG9yaWdpbmFsbHkgYSBuZXh0VGljayBzaGltIGluY2x1ZGVkIGluIFEuIFRoaXMgd2FzIGZhY3RvcmVkIG91dFxuLy8gaW50byB0aGlzIEFTQVAgcGFja2FnZS4gSXQgd2FzIGxhdGVyIGFkYXB0ZWQgdG8gUlNWUCB3aGljaCBtYWRlIGZ1cnRoZXJcbi8vIGFtZW5kbWVudHMuIFRoZXNlIGRlY2lzaW9ucywgcGFydGljdWxhcmx5IHRvIG1hcmdpbmFsaXplIE1lc3NhZ2VDaGFubmVsIGFuZFxuLy8gdG8gY2FwdHVyZSB0aGUgTXV0YXRpb25PYnNlcnZlciBpbXBsZW1lbnRhdGlvbiBpbiBhIGNsb3N1cmUsIHdlcmUgaW50ZWdyYXRlZFxuLy8gYmFjayBpbnRvIEFTQVAgcHJvcGVyLlxuLy8gaHR0cHM6Ly9naXRodWIuY29tL3RpbGRlaW8vcnN2cC5qcy9ibG9iL2NkZGY3MjMyNTQ2YTljZjg1ODUyNGI3NWNkZTZmOWVkZjcyNjIwYTcvbGliL3JzdnAvYXNhcC5qc1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG52YXIgX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQgPSBmdW5jdGlvbiAob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH07XG5cbnZhciBfY2xhc3NDYWxsQ2hlY2sgPSBmdW5jdGlvbiAoaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH07XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbnZhciBfaXNEaXNwb3NhYmxlID0gcmVxdWlyZSgnLi9pc0Rpc3Bvc2FibGUnKTtcblxudmFyIF9pc0Rpc3Bvc2FibGUyID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX2lzRGlzcG9zYWJsZSk7XG5cbi8qKlxuICogUmVwcmVzZW50cyBhIGdyb3VwIG9mIGRpc3Bvc2FibGUgcmVzb3VyY2VzIHRoYXQgYXJlIGRpc3Bvc2VkIHRvZ2V0aGVyLlxuICovXG5cbnZhciBDb21wb3NpdGVEaXNwb3NhYmxlID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gQ29tcG9zaXRlRGlzcG9zYWJsZSgpIHtcbiAgICBmb3IgKHZhciBfbGVuID0gYXJndW1lbnRzLmxlbmd0aCwgZGlzcG9zYWJsZXMgPSBBcnJheShfbGVuKSwgX2tleSA9IDA7IF9rZXkgPCBfbGVuOyBfa2V5KyspIHtcbiAgICAgIGRpc3Bvc2FibGVzW19rZXldID0gYXJndW1lbnRzW19rZXldO1xuICAgIH1cblxuICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBDb21wb3NpdGVEaXNwb3NhYmxlKTtcblxuICAgIGlmIChBcnJheS5pc0FycmF5KGRpc3Bvc2FibGVzWzBdKSAmJiBkaXNwb3NhYmxlcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIGRpc3Bvc2FibGVzID0gZGlzcG9zYWJsZXNbMF07XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBkaXNwb3NhYmxlcy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKCFfaXNEaXNwb3NhYmxlMlsnZGVmYXVsdCddKGRpc3Bvc2FibGVzW2ldKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0V4cGVjdGVkIGEgZGlzcG9zYWJsZScpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuZGlzcG9zYWJsZXMgPSBkaXNwb3NhYmxlcztcbiAgICB0aGlzLmlzRGlzcG9zZWQgPSBmYWxzZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGRzIGEgZGlzcG9zYWJsZSB0byB0aGUgQ29tcG9zaXRlRGlzcG9zYWJsZSBvciBkaXNwb3NlcyB0aGUgZGlzcG9zYWJsZSBpZiB0aGUgQ29tcG9zaXRlRGlzcG9zYWJsZSBpcyBkaXNwb3NlZC5cbiAgICogQHBhcmFtIHtEaXNwb3NhYmxlfSBpdGVtIERpc3Bvc2FibGUgdG8gYWRkLlxuICAgKi9cblxuICBDb21wb3NpdGVEaXNwb3NhYmxlLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbiBhZGQoaXRlbSkge1xuICAgIGlmICh0aGlzLmlzRGlzcG9zZWQpIHtcbiAgICAgIGl0ZW0uZGlzcG9zZSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmRpc3Bvc2FibGVzLnB1c2goaXRlbSk7XG4gICAgfVxuICB9O1xuXG4gIC8qKlxuICAgKiBSZW1vdmVzIGFuZCBkaXNwb3NlcyB0aGUgZmlyc3Qgb2NjdXJyZW5jZSBvZiBhIGRpc3Bvc2FibGUgZnJvbSB0aGUgQ29tcG9zaXRlRGlzcG9zYWJsZS5cbiAgICogQHBhcmFtIHtEaXNwb3NhYmxlfSBpdGVtIERpc3Bvc2FibGUgdG8gcmVtb3ZlLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gdHJ1ZSBpZiBmb3VuZDsgZmFsc2Ugb3RoZXJ3aXNlLlxuICAgKi9cblxuICBDb21wb3NpdGVEaXNwb3NhYmxlLnByb3RvdHlwZS5yZW1vdmUgPSBmdW5jdGlvbiByZW1vdmUoaXRlbSkge1xuICAgIGlmICh0aGlzLmlzRGlzcG9zZWQpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB2YXIgaW5kZXggPSB0aGlzLmRpc3Bvc2FibGVzLmluZGV4T2YoaXRlbSk7XG4gICAgaWYgKGluZGV4ID09PSAtMSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHRoaXMuZGlzcG9zYWJsZXMuc3BsaWNlKGluZGV4LCAxKTtcbiAgICBpdGVtLmRpc3Bvc2UoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfTtcblxuICAvKipcbiAgICogRGlzcG9zZXMgYWxsIGRpc3Bvc2FibGVzIGluIHRoZSBncm91cCBhbmQgcmVtb3ZlcyB0aGVtIGZyb20gdGhlIGdyb3VwLlxuICAgKi9cblxuICBDb21wb3NpdGVEaXNwb3NhYmxlLnByb3RvdHlwZS5kaXNwb3NlID0gZnVuY3Rpb24gZGlzcG9zZSgpIHtcbiAgICBpZiAodGhpcy5pc0Rpc3Bvc2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIGxlbiA9IHRoaXMuZGlzcG9zYWJsZXMubGVuZ3RoO1xuICAgIHZhciBjdXJyZW50RGlzcG9zYWJsZXMgPSBuZXcgQXJyYXkobGVuKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICBjdXJyZW50RGlzcG9zYWJsZXNbaV0gPSB0aGlzLmRpc3Bvc2FibGVzW2ldO1xuICAgIH1cblxuICAgIHRoaXMuaXNEaXNwb3NlZCA9IHRydWU7XG4gICAgdGhpcy5kaXNwb3NhYmxlcyA9IFtdO1xuICAgIHRoaXMubGVuZ3RoID0gMDtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIGN1cnJlbnREaXNwb3NhYmxlc1tpXS5kaXNwb3NlKCk7XG4gICAgfVxuICB9O1xuXG4gIHJldHVybiBDb21wb3NpdGVEaXNwb3NhYmxlO1xufSkoKTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gQ29tcG9zaXRlRGlzcG9zYWJsZTtcbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIlwidXNlIHN0cmljdFwiO1xuXG52YXIgX2NsYXNzQ2FsbENoZWNrID0gZnVuY3Rpb24gKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpOyB9IH07XG5cbnZhciBfY3JlYXRlQ2xhc3MgPSAoZnVuY3Rpb24gKCkgeyBmdW5jdGlvbiBkZWZpbmVQcm9wZXJ0aWVzKHRhcmdldCwgcHJvcHMpIHsgZm9yICh2YXIgaSA9IDA7IGkgPCBwcm9wcy5sZW5ndGg7IGkrKykgeyB2YXIgZGVzY3JpcHRvciA9IHByb3BzW2ldOyBkZXNjcmlwdG9yLmVudW1lcmFibGUgPSBkZXNjcmlwdG9yLmVudW1lcmFibGUgfHwgZmFsc2U7IGRlc2NyaXB0b3IuY29uZmlndXJhYmxlID0gdHJ1ZTsgaWYgKFwidmFsdWVcIiBpbiBkZXNjcmlwdG9yKSBkZXNjcmlwdG9yLndyaXRhYmxlID0gdHJ1ZTsgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRhcmdldCwgZGVzY3JpcHRvci5rZXksIGRlc2NyaXB0b3IpOyB9IH0gcmV0dXJuIGZ1bmN0aW9uIChDb25zdHJ1Y3RvciwgcHJvdG9Qcm9wcywgc3RhdGljUHJvcHMpIHsgaWYgKHByb3RvUHJvcHMpIGRlZmluZVByb3BlcnRpZXMoQ29uc3RydWN0b3IucHJvdG90eXBlLCBwcm90b1Byb3BzKTsgaWYgKHN0YXRpY1Byb3BzKSBkZWZpbmVQcm9wZXJ0aWVzKENvbnN0cnVjdG9yLCBzdGF0aWNQcm9wcyk7IHJldHVybiBDb25zdHJ1Y3RvcjsgfTsgfSkoKTtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbnZhciBub29wID0gZnVuY3Rpb24gbm9vcCgpIHt9O1xuXG4vKipcbiAqIFRoZSBiYXNpYyBkaXNwb3NhYmxlLlxuICovXG5cbnZhciBEaXNwb3NhYmxlID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gRGlzcG9zYWJsZShhY3Rpb24pIHtcbiAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgRGlzcG9zYWJsZSk7XG5cbiAgICB0aGlzLmlzRGlzcG9zZWQgPSBmYWxzZTtcbiAgICB0aGlzLmFjdGlvbiA9IGFjdGlvbiB8fCBub29wO1xuICB9XG5cbiAgRGlzcG9zYWJsZS5wcm90b3R5cGUuZGlzcG9zZSA9IGZ1bmN0aW9uIGRpc3Bvc2UoKSB7XG4gICAgaWYgKCF0aGlzLmlzRGlzcG9zZWQpIHtcbiAgICAgIHRoaXMuYWN0aW9uLmNhbGwobnVsbCk7XG4gICAgICB0aGlzLmlzRGlzcG9zZWQgPSB0cnVlO1xuICAgIH1cbiAgfTtcblxuICBfY3JlYXRlQ2xhc3MoRGlzcG9zYWJsZSwgbnVsbCwgW3tcbiAgICBrZXk6IFwiZW1wdHlcIixcbiAgICBlbnVtZXJhYmxlOiB0cnVlLFxuICAgIHZhbHVlOiB7IGRpc3Bvc2U6IG5vb3AgfVxuICB9XSk7XG5cbiAgcmV0dXJuIERpc3Bvc2FibGU7XG59KSgpO1xuXG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IERpc3Bvc2FibGU7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbXCJkZWZhdWx0XCJdOyIsIid1c2Ugc3RyaWN0JztcblxudmFyIF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkID0gZnVuY3Rpb24gKG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9O1xuXG52YXIgX2NsYXNzQ2FsbENoZWNrID0gZnVuY3Rpb24gKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9O1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG52YXIgX2lzRGlzcG9zYWJsZSA9IHJlcXVpcmUoJy4vaXNEaXNwb3NhYmxlJyk7XG5cbnZhciBfaXNEaXNwb3NhYmxlMiA9IF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKF9pc0Rpc3Bvc2FibGUpO1xuXG52YXIgU2VyaWFsRGlzcG9zYWJsZSA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIFNlcmlhbERpc3Bvc2FibGUoKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFNlcmlhbERpc3Bvc2FibGUpO1xuXG4gICAgdGhpcy5pc0Rpc3Bvc2VkID0gZmFsc2U7XG4gICAgdGhpcy5jdXJyZW50ID0gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXRzIHRoZSB1bmRlcmx5aW5nIGRpc3Bvc2FibGUuXG4gICAqIEByZXR1cm4gVGhlIHVuZGVybHlpbmcgZGlzcG9zYWJsZS5cbiAgICovXG5cbiAgU2VyaWFsRGlzcG9zYWJsZS5wcm90b3R5cGUuZ2V0RGlzcG9zYWJsZSA9IGZ1bmN0aW9uIGdldERpc3Bvc2FibGUoKSB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudDtcbiAgfTtcblxuICAvKipcbiAgICogU2V0cyB0aGUgdW5kZXJseWluZyBkaXNwb3NhYmxlLlxuICAgKiBAcGFyYW0ge0Rpc3Bvc2FibGV9IHZhbHVlIFRoZSBuZXcgdW5kZXJseWluZyBkaXNwb3NhYmxlLlxuICAgKi9cblxuICBTZXJpYWxEaXNwb3NhYmxlLnByb3RvdHlwZS5zZXREaXNwb3NhYmxlID0gZnVuY3Rpb24gc2V0RGlzcG9zYWJsZSgpIHtcbiAgICB2YXIgdmFsdWUgPSBhcmd1bWVudHNbMF0gPT09IHVuZGVmaW5lZCA/IG51bGwgOiBhcmd1bWVudHNbMF07XG5cbiAgICBpZiAodmFsdWUgIT0gbnVsbCAmJiAhX2lzRGlzcG9zYWJsZTJbJ2RlZmF1bHQnXSh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRXhwZWN0ZWQgZWl0aGVyIGFuIGVtcHR5IHZhbHVlIG9yIGEgdmFsaWQgZGlzcG9zYWJsZScpO1xuICAgIH1cblxuICAgIHZhciBpc0Rpc3Bvc2VkID0gdGhpcy5pc0Rpc3Bvc2VkO1xuICAgIHZhciBwcmV2aW91cyA9IHVuZGVmaW5lZDtcblxuICAgIGlmICghaXNEaXNwb3NlZCkge1xuICAgICAgcHJldmlvdXMgPSB0aGlzLmN1cnJlbnQ7XG4gICAgICB0aGlzLmN1cnJlbnQgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgIHByZXZpb3VzLmRpc3Bvc2UoKTtcbiAgICB9XG5cbiAgICBpZiAoaXNEaXNwb3NlZCAmJiB2YWx1ZSkge1xuICAgICAgdmFsdWUuZGlzcG9zZSgpO1xuICAgIH1cbiAgfTtcblxuICAvKipcbiAgICogRGlzcG9zZXMgdGhlIHVuZGVybHlpbmcgZGlzcG9zYWJsZSBhcyB3ZWxsIGFzIGFsbCBmdXR1cmUgcmVwbGFjZW1lbnRzLlxuICAgKi9cblxuICBTZXJpYWxEaXNwb3NhYmxlLnByb3RvdHlwZS5kaXNwb3NlID0gZnVuY3Rpb24gZGlzcG9zZSgpIHtcbiAgICBpZiAodGhpcy5pc0Rpc3Bvc2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5pc0Rpc3Bvc2VkID0gdHJ1ZTtcbiAgICB2YXIgcHJldmlvdXMgPSB0aGlzLmN1cnJlbnQ7XG4gICAgdGhpcy5jdXJyZW50ID0gbnVsbDtcblxuICAgIGlmIChwcmV2aW91cykge1xuICAgICAgcHJldmlvdXMuZGlzcG9zZSgpO1xuICAgIH1cbiAgfTtcblxuICByZXR1cm4gU2VyaWFsRGlzcG9zYWJsZTtcbn0pKCk7XG5cbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IFNlcmlhbERpc3Bvc2FibGU7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbnZhciBfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZCA9IGZ1bmN0aW9uIChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfTtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxudmFyIF9pc0Rpc3Bvc2FibGUyID0gcmVxdWlyZSgnLi9pc0Rpc3Bvc2FibGUnKTtcblxudmFyIF9pc0Rpc3Bvc2FibGUzID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX2lzRGlzcG9zYWJsZTIpO1xuXG5leHBvcnRzLmlzRGlzcG9zYWJsZSA9IF9pc0Rpc3Bvc2FibGUzWydkZWZhdWx0J107XG5cbnZhciBfRGlzcG9zYWJsZTIgPSByZXF1aXJlKCcuL0Rpc3Bvc2FibGUnKTtcblxudmFyIF9EaXNwb3NhYmxlMyA9IF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKF9EaXNwb3NhYmxlMik7XG5cbmV4cG9ydHMuRGlzcG9zYWJsZSA9IF9EaXNwb3NhYmxlM1snZGVmYXVsdCddO1xuXG52YXIgX0NvbXBvc2l0ZURpc3Bvc2FibGUyID0gcmVxdWlyZSgnLi9Db21wb3NpdGVEaXNwb3NhYmxlJyk7XG5cbnZhciBfQ29tcG9zaXRlRGlzcG9zYWJsZTMgPSBfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZChfQ29tcG9zaXRlRGlzcG9zYWJsZTIpO1xuXG5leHBvcnRzLkNvbXBvc2l0ZURpc3Bvc2FibGUgPSBfQ29tcG9zaXRlRGlzcG9zYWJsZTNbJ2RlZmF1bHQnXTtcblxudmFyIF9TZXJpYWxEaXNwb3NhYmxlMiA9IHJlcXVpcmUoJy4vU2VyaWFsRGlzcG9zYWJsZScpO1xuXG52YXIgX1NlcmlhbERpc3Bvc2FibGUzID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX1NlcmlhbERpc3Bvc2FibGUyKTtcblxuZXhwb3J0cy5TZXJpYWxEaXNwb3NhYmxlID0gX1NlcmlhbERpc3Bvc2FibGUzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gaXNEaXNwb3NhYmxlO1xuXG5mdW5jdGlvbiBpc0Rpc3Bvc2FibGUob2JqKSB7XG4gIHJldHVybiBCb29sZWFuKG9iaiAmJiB0eXBlb2Ygb2JqLmRpc3Bvc2UgPT09ICdmdW5jdGlvbicpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKG9iaikgeyBpZiAob2JqICYmIG9iai5fX2VzTW9kdWxlKSB7IHJldHVybiBvYmo7IH0gZWxzZSB7IHZhciBuZXdPYmogPSB7fTsgaWYgKG9iaiAhPSBudWxsKSB7IGZvciAodmFyIGtleSBpbiBvYmopIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIG5ld09ialtrZXldID0gb2JqW2tleV07IH0gfSBuZXdPYmpbJ2RlZmF1bHQnXSA9IG9iajsgcmV0dXJuIG5ld09iajsgfSB9XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbnZhciBfcmVkdXhMaWJDcmVhdGVTdG9yZSA9IHJlcXVpcmUoJ3JlZHV4L2xpYi9jcmVhdGVTdG9yZScpO1xuXG52YXIgX3JlZHV4TGliQ3JlYXRlU3RvcmUyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfcmVkdXhMaWJDcmVhdGVTdG9yZSk7XG5cbnZhciBfcmVkdWNlcnMgPSByZXF1aXJlKCcuL3JlZHVjZXJzJyk7XG5cbnZhciBfcmVkdWNlcnMyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfcmVkdWNlcnMpO1xuXG52YXIgX2FjdGlvbnNEcmFnRHJvcCA9IHJlcXVpcmUoJy4vYWN0aW9ucy9kcmFnRHJvcCcpO1xuXG52YXIgZHJhZ0Ryb3BBY3Rpb25zID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX2FjdGlvbnNEcmFnRHJvcCk7XG5cbnZhciBfRHJhZ0Ryb3BNb25pdG9yID0gcmVxdWlyZSgnLi9EcmFnRHJvcE1vbml0b3InKTtcblxudmFyIF9EcmFnRHJvcE1vbml0b3IyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfRHJhZ0Ryb3BNb25pdG9yKTtcblxudmFyIF9IYW5kbGVyUmVnaXN0cnkgPSByZXF1aXJlKCcuL0hhbmRsZXJSZWdpc3RyeScpO1xuXG52YXIgX0hhbmRsZXJSZWdpc3RyeTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9IYW5kbGVyUmVnaXN0cnkpO1xuXG52YXIgRHJhZ0Ryb3BNYW5hZ2VyID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gRHJhZ0Ryb3BNYW5hZ2VyKGNyZWF0ZUJhY2tlbmQpIHtcbiAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgRHJhZ0Ryb3BNYW5hZ2VyKTtcblxuICAgIHZhciBzdG9yZSA9IF9yZWR1eExpYkNyZWF0ZVN0b3JlMlsnZGVmYXVsdCddKF9yZWR1Y2VyczJbJ2RlZmF1bHQnXSk7XG5cbiAgICB0aGlzLnN0b3JlID0gc3RvcmU7XG4gICAgdGhpcy5tb25pdG9yID0gbmV3IF9EcmFnRHJvcE1vbml0b3IyWydkZWZhdWx0J10oc3RvcmUpO1xuICAgIHRoaXMucmVnaXN0cnkgPSB0aGlzLm1vbml0b3IucmVnaXN0cnk7XG4gICAgdGhpcy5iYWNrZW5kID0gY3JlYXRlQmFja2VuZCh0aGlzKTtcblxuICAgIHN0b3JlLnN1YnNjcmliZSh0aGlzLmhhbmRsZVJlZkNvdW50Q2hhbmdlLmJpbmQodGhpcykpO1xuICB9XG5cbiAgRHJhZ0Ryb3BNYW5hZ2VyLnByb3RvdHlwZS5oYW5kbGVSZWZDb3VudENoYW5nZSA9IGZ1bmN0aW9uIGhhbmRsZVJlZkNvdW50Q2hhbmdlKCkge1xuICAgIHZhciBzaG91bGRTZXRVcCA9IHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5yZWZDb3VudCA+IDA7XG4gICAgaWYgKHNob3VsZFNldFVwICYmICF0aGlzLmlzU2V0VXApIHtcbiAgICAgIHRoaXMuYmFja2VuZC5zZXR1cCgpO1xuICAgICAgdGhpcy5pc1NldFVwID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKCFzaG91bGRTZXRVcCAmJiB0aGlzLmlzU2V0VXApIHtcbiAgICAgIHRoaXMuYmFja2VuZC50ZWFyZG93bigpO1xuICAgICAgdGhpcy5pc1NldFVwID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIERyYWdEcm9wTWFuYWdlci5wcm90b3R5cGUuZ2V0TW9uaXRvciA9IGZ1bmN0aW9uIGdldE1vbml0b3IoKSB7XG4gICAgcmV0dXJuIHRoaXMubW9uaXRvcjtcbiAgfTtcblxuICBEcmFnRHJvcE1hbmFnZXIucHJvdG90eXBlLmdldEJhY2tlbmQgPSBmdW5jdGlvbiBnZXRCYWNrZW5kKCkge1xuICAgIHJldHVybiB0aGlzLmJhY2tlbmQ7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNYW5hZ2VyLnByb3RvdHlwZS5nZXRSZWdpc3RyeSA9IGZ1bmN0aW9uIGdldFJlZ2lzdHJ5KCkge1xuICAgIHJldHVybiB0aGlzLnJlZ2lzdHJ5O1xuICB9O1xuXG4gIERyYWdEcm9wTWFuYWdlci5wcm90b3R5cGUuZ2V0QWN0aW9ucyA9IGZ1bmN0aW9uIGdldEFjdGlvbnMoKSB7XG4gICAgdmFyIG1hbmFnZXIgPSB0aGlzO1xuICAgIHZhciBkaXNwYXRjaCA9IHRoaXMuc3RvcmUuZGlzcGF0Y2g7XG5cbiAgICBmdW5jdGlvbiBiaW5kQWN0aW9uQ3JlYXRvcihhY3Rpb25DcmVhdG9yKSB7XG4gICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgYWN0aW9uID0gYWN0aW9uQ3JlYXRvci5hcHBseShtYW5hZ2VyLCBhcmd1bWVudHMpO1xuICAgICAgICBpZiAodHlwZW9mIGFjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICBkaXNwYXRjaChhY3Rpb24pO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBPYmplY3Qua2V5cyhkcmFnRHJvcEFjdGlvbnMpLmZpbHRlcihmdW5jdGlvbiAoa2V5KSB7XG4gICAgICByZXR1cm4gdHlwZW9mIGRyYWdEcm9wQWN0aW9uc1trZXldID09PSAnZnVuY3Rpb24nO1xuICAgIH0pLnJlZHVjZShmdW5jdGlvbiAoYm91bmRBY3Rpb25zLCBrZXkpIHtcbiAgICAgIGJvdW5kQWN0aW9uc1trZXldID0gYmluZEFjdGlvbkNyZWF0b3IoZHJhZ0Ryb3BBY3Rpb25zW2tleV0pO1xuICAgICAgcmV0dXJuIGJvdW5kQWN0aW9ucztcbiAgICB9LCB7fSk7XG4gIH07XG5cbiAgcmV0dXJuIERyYWdEcm9wTWFuYWdlcjtcbn0pKCk7XG5cbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IERyYWdEcm9wTWFuYWdlcjtcbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH1cblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIF91dGlsc01hdGNoZXNUeXBlID0gcmVxdWlyZSgnLi91dGlscy9tYXRjaGVzVHlwZScpO1xuXG52YXIgX3V0aWxzTWF0Y2hlc1R5cGUyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfdXRpbHNNYXRjaGVzVHlwZSk7XG5cbnZhciBfbG9kYXNoSXNBcnJheSA9IHJlcXVpcmUoJ2xvZGFzaC9pc0FycmF5Jyk7XG5cbnZhciBfbG9kYXNoSXNBcnJheTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hJc0FycmF5KTtcblxudmFyIF9IYW5kbGVyUmVnaXN0cnkgPSByZXF1aXJlKCcuL0hhbmRsZXJSZWdpc3RyeScpO1xuXG52YXIgX0hhbmRsZXJSZWdpc3RyeTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9IYW5kbGVyUmVnaXN0cnkpO1xuXG52YXIgX3JlZHVjZXJzRHJhZ09mZnNldCA9IHJlcXVpcmUoJy4vcmVkdWNlcnMvZHJhZ09mZnNldCcpO1xuXG52YXIgX3JlZHVjZXJzRGlydHlIYW5kbGVySWRzID0gcmVxdWlyZSgnLi9yZWR1Y2Vycy9kaXJ0eUhhbmRsZXJJZHMnKTtcblxudmFyIERyYWdEcm9wTW9uaXRvciA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIERyYWdEcm9wTW9uaXRvcihzdG9yZSkge1xuICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBEcmFnRHJvcE1vbml0b3IpO1xuXG4gICAgdGhpcy5zdG9yZSA9IHN0b3JlO1xuICAgIHRoaXMucmVnaXN0cnkgPSBuZXcgX0hhbmRsZXJSZWdpc3RyeTJbJ2RlZmF1bHQnXShzdG9yZSk7XG4gIH1cblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLnN1YnNjcmliZVRvU3RhdGVDaGFuZ2UgPSBmdW5jdGlvbiBzdWJzY3JpYmVUb1N0YXRlQ2hhbmdlKGxpc3RlbmVyKSB7XG4gICAgdmFyIF90aGlzID0gdGhpcztcblxuICAgIHZhciBfcmVmID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbMV07XG5cbiAgICB2YXIgaGFuZGxlcklkcyA9IF9yZWYuaGFuZGxlcklkcztcblxuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGxpc3RlbmVyID09PSAnZnVuY3Rpb24nLCAnbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uLicpO1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGhhbmRsZXJJZHMgPT09ICd1bmRlZmluZWQnIHx8IF9sb2Rhc2hJc0FycmF5MlsnZGVmYXVsdCddKGhhbmRsZXJJZHMpLCAnaGFuZGxlcklkcywgd2hlbiBzcGVjaWZpZWQsIG11c3QgYmUgYW4gYXJyYXkgb2Ygc3RyaW5ncy4nKTtcblxuICAgIHZhciBwcmV2U3RhdGVJZCA9IHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5zdGF0ZUlkO1xuICAgIHZhciBoYW5kbGVDaGFuZ2UgPSBmdW5jdGlvbiBoYW5kbGVDaGFuZ2UoKSB7XG4gICAgICB2YXIgc3RhdGUgPSBfdGhpcy5zdG9yZS5nZXRTdGF0ZSgpO1xuICAgICAgdmFyIGN1cnJlbnRTdGF0ZUlkID0gc3RhdGUuc3RhdGVJZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHZhciBjYW5Ta2lwTGlzdGVuZXIgPSBjdXJyZW50U3RhdGVJZCA9PT0gcHJldlN0YXRlSWQgfHwgY3VycmVudFN0YXRlSWQgPT09IHByZXZTdGF0ZUlkICsgMSAmJiAhX3JlZHVjZXJzRGlydHlIYW5kbGVySWRzLmFyZURpcnR5KHN0YXRlLmRpcnR5SGFuZGxlcklkcywgaGFuZGxlcklkcyk7XG5cbiAgICAgICAgaWYgKCFjYW5Ta2lwTGlzdGVuZXIpIHtcbiAgICAgICAgICBsaXN0ZW5lcigpO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBwcmV2U3RhdGVJZCA9IGN1cnJlbnRTdGF0ZUlkO1xuICAgICAgfVxuICAgIH07XG5cbiAgICByZXR1cm4gdGhpcy5zdG9yZS5zdWJzY3JpYmUoaGFuZGxlQ2hhbmdlKTtcbiAgfTtcblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLnN1YnNjcmliZVRvT2Zmc2V0Q2hhbmdlID0gZnVuY3Rpb24gc3Vic2NyaWJlVG9PZmZzZXRDaGFuZ2UobGlzdGVuZXIpIHtcbiAgICB2YXIgX3RoaXMyID0gdGhpcztcblxuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGxpc3RlbmVyID09PSAnZnVuY3Rpb24nLCAnbGlzdGVuZXIgbXVzdCBiZSBhIGZ1bmN0aW9uLicpO1xuXG4gICAgdmFyIHByZXZpb3VzU3RhdGUgPSB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09mZnNldDtcbiAgICB2YXIgaGFuZGxlQ2hhbmdlID0gZnVuY3Rpb24gaGFuZGxlQ2hhbmdlKCkge1xuICAgICAgdmFyIG5leHRTdGF0ZSA9IF90aGlzMi5zdG9yZS5nZXRTdGF0ZSgpLmRyYWdPZmZzZXQ7XG4gICAgICBpZiAobmV4dFN0YXRlID09PSBwcmV2aW91c1N0YXRlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgcHJldmlvdXNTdGF0ZSA9IG5leHRTdGF0ZTtcbiAgICAgIGxpc3RlbmVyKCk7XG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLnN0b3JlLnN1YnNjcmliZShoYW5kbGVDaGFuZ2UpO1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuY2FuRHJhZ1NvdXJjZSA9IGZ1bmN0aW9uIGNhbkRyYWdTb3VyY2Uoc291cmNlSWQpIHtcbiAgICB2YXIgc291cmNlID0gdGhpcy5yZWdpc3RyeS5nZXRTb3VyY2Uoc291cmNlSWQpO1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oc291cmNlLCAnRXhwZWN0ZWQgdG8gZmluZCBhIHZhbGlkIHNvdXJjZS4nKTtcblxuICAgIGlmICh0aGlzLmlzRHJhZ2dpbmcoKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiBzb3VyY2UuY2FuRHJhZyh0aGlzLCBzb3VyY2VJZCk7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5jYW5Ecm9wT25UYXJnZXQgPSBmdW5jdGlvbiBjYW5Ecm9wT25UYXJnZXQodGFyZ2V0SWQpIHtcbiAgICB2YXIgdGFyZ2V0ID0gdGhpcy5yZWdpc3RyeS5nZXRUYXJnZXQodGFyZ2V0SWQpO1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odGFyZ2V0LCAnRXhwZWN0ZWQgdG8gZmluZCBhIHZhbGlkIHRhcmdldC4nKTtcblxuICAgIGlmICghdGhpcy5pc0RyYWdnaW5nKCkgfHwgdGhpcy5kaWREcm9wKCkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB2YXIgdGFyZ2V0VHlwZSA9IHRoaXMucmVnaXN0cnkuZ2V0VGFyZ2V0VHlwZSh0YXJnZXRJZCk7XG4gICAgdmFyIGRyYWdnZWRJdGVtVHlwZSA9IHRoaXMuZ2V0SXRlbVR5cGUoKTtcbiAgICByZXR1cm4gX3V0aWxzTWF0Y2hlc1R5cGUyWydkZWZhdWx0J10odGFyZ2V0VHlwZSwgZHJhZ2dlZEl0ZW1UeXBlKSAmJiB0YXJnZXQuY2FuRHJvcCh0aGlzLCB0YXJnZXRJZCk7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5pc0RyYWdnaW5nID0gZnVuY3Rpb24gaXNEcmFnZ2luZygpIHtcbiAgICByZXR1cm4gQm9vbGVhbih0aGlzLmdldEl0ZW1UeXBlKCkpO1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuaXNEcmFnZ2luZ1NvdXJjZSA9IGZ1bmN0aW9uIGlzRHJhZ2dpbmdTb3VyY2Uoc291cmNlSWQpIHtcbiAgICB2YXIgc291cmNlID0gdGhpcy5yZWdpc3RyeS5nZXRTb3VyY2Uoc291cmNlSWQsIHRydWUpO1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oc291cmNlLCAnRXhwZWN0ZWQgdG8gZmluZCBhIHZhbGlkIHNvdXJjZS4nKTtcblxuICAgIGlmICghdGhpcy5pc0RyYWdnaW5nKCkgfHwgIXRoaXMuaXNTb3VyY2VQdWJsaWMoKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHZhciBzb3VyY2VUeXBlID0gdGhpcy5yZWdpc3RyeS5nZXRTb3VyY2VUeXBlKHNvdXJjZUlkKTtcbiAgICB2YXIgZHJhZ2dlZEl0ZW1UeXBlID0gdGhpcy5nZXRJdGVtVHlwZSgpO1xuICAgIGlmIChzb3VyY2VUeXBlICE9PSBkcmFnZ2VkSXRlbVR5cGUpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gc291cmNlLmlzRHJhZ2dpbmcodGhpcywgc291cmNlSWQpO1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuaXNPdmVyVGFyZ2V0ID0gZnVuY3Rpb24gaXNPdmVyVGFyZ2V0KHRhcmdldElkKSB7XG4gICAgdmFyIF9yZWYyID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbMV07XG5cbiAgICB2YXIgX3JlZjIkc2hhbGxvdyA9IF9yZWYyLnNoYWxsb3c7XG4gICAgdmFyIHNoYWxsb3cgPSBfcmVmMiRzaGFsbG93ID09PSB1bmRlZmluZWQgPyBmYWxzZSA6IF9yZWYyJHNoYWxsb3c7XG5cbiAgICBpZiAoIXRoaXMuaXNEcmFnZ2luZygpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdmFyIHRhcmdldFR5cGUgPSB0aGlzLnJlZ2lzdHJ5LmdldFRhcmdldFR5cGUodGFyZ2V0SWQpO1xuICAgIHZhciBkcmFnZ2VkSXRlbVR5cGUgPSB0aGlzLmdldEl0ZW1UeXBlKCk7XG4gICAgaWYgKCFfdXRpbHNNYXRjaGVzVHlwZTJbJ2RlZmF1bHQnXSh0YXJnZXRUeXBlLCBkcmFnZ2VkSXRlbVR5cGUpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdmFyIHRhcmdldElkcyA9IHRoaXMuZ2V0VGFyZ2V0SWRzKCk7XG4gICAgaWYgKCF0YXJnZXRJZHMubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdmFyIGluZGV4ID0gdGFyZ2V0SWRzLmluZGV4T2YodGFyZ2V0SWQpO1xuICAgIGlmIChzaGFsbG93KSB7XG4gICAgICByZXR1cm4gaW5kZXggPT09IHRhcmdldElkcy5sZW5ndGggLSAxO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gaW5kZXggPiAtMTtcbiAgICB9XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5nZXRJdGVtVHlwZSA9IGZ1bmN0aW9uIGdldEl0ZW1UeXBlKCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09wZXJhdGlvbi5pdGVtVHlwZTtcbiAgfTtcblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLmdldEl0ZW0gPSBmdW5jdGlvbiBnZXRJdGVtKCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09wZXJhdGlvbi5pdGVtO1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuZ2V0U291cmNlSWQgPSBmdW5jdGlvbiBnZXRTb3VyY2VJZCgpIHtcbiAgICByZXR1cm4gdGhpcy5zdG9yZS5nZXRTdGF0ZSgpLmRyYWdPcGVyYXRpb24uc291cmNlSWQ7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5nZXRUYXJnZXRJZHMgPSBmdW5jdGlvbiBnZXRUYXJnZXRJZHMoKSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5kcmFnT3BlcmF0aW9uLnRhcmdldElkcztcbiAgfTtcblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLmdldERyb3BSZXN1bHQgPSBmdW5jdGlvbiBnZXREcm9wUmVzdWx0KCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09wZXJhdGlvbi5kcm9wUmVzdWx0O1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuZGlkRHJvcCA9IGZ1bmN0aW9uIGRpZERyb3AoKSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5kcmFnT3BlcmF0aW9uLmRpZERyb3A7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5pc1NvdXJjZVB1YmxpYyA9IGZ1bmN0aW9uIGlzU291cmNlUHVibGljKCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09wZXJhdGlvbi5pc1NvdXJjZVB1YmxpYztcbiAgfTtcblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLmdldEluaXRpYWxDbGllbnRPZmZzZXQgPSBmdW5jdGlvbiBnZXRJbml0aWFsQ2xpZW50T2Zmc2V0KCkge1xuICAgIHJldHVybiB0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09mZnNldC5pbml0aWFsQ2xpZW50T2Zmc2V0O1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuZ2V0SW5pdGlhbFNvdXJjZUNsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldEluaXRpYWxTb3VyY2VDbGllbnRPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5kcmFnT2Zmc2V0LmluaXRpYWxTb3VyY2VDbGllbnRPZmZzZXQ7XG4gIH07XG5cbiAgRHJhZ0Ryb3BNb25pdG9yLnByb3RvdHlwZS5nZXRDbGllbnRPZmZzZXQgPSBmdW5jdGlvbiBnZXRDbGllbnRPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuc3RvcmUuZ2V0U3RhdGUoKS5kcmFnT2Zmc2V0LmNsaWVudE9mZnNldDtcbiAgfTtcblxuICBEcmFnRHJvcE1vbml0b3IucHJvdG90eXBlLmdldFNvdXJjZUNsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldFNvdXJjZUNsaWVudE9mZnNldCgpIHtcbiAgICByZXR1cm4gX3JlZHVjZXJzRHJhZ09mZnNldC5nZXRTb3VyY2VDbGllbnRPZmZzZXQodGhpcy5zdG9yZS5nZXRTdGF0ZSgpLmRyYWdPZmZzZXQpO1xuICB9O1xuXG4gIERyYWdEcm9wTW9uaXRvci5wcm90b3R5cGUuZ2V0RGlmZmVyZW5jZUZyb21Jbml0aWFsT2Zmc2V0ID0gZnVuY3Rpb24gZ2V0RGlmZmVyZW5jZUZyb21Jbml0aWFsT2Zmc2V0KCkge1xuICAgIHJldHVybiBfcmVkdWNlcnNEcmFnT2Zmc2V0LmdldERpZmZlcmVuY2VGcm9tSW5pdGlhbE9mZnNldCh0aGlzLnN0b3JlLmdldFN0YXRlKCkuZHJhZ09mZnNldCk7XG4gIH07XG5cbiAgcmV0dXJuIERyYWdEcm9wTW9uaXRvcjtcbn0pKCk7XG5cbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IERyYWdEcm9wTW9uaXRvcjtcbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIlwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgRHJhZ1NvdXJjZSA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIERyYWdTb3VyY2UoKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIERyYWdTb3VyY2UpO1xuICB9XG5cbiAgRHJhZ1NvdXJjZS5wcm90b3R5cGUuY2FuRHJhZyA9IGZ1bmN0aW9uIGNhbkRyYWcoKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG5cbiAgRHJhZ1NvdXJjZS5wcm90b3R5cGUuaXNEcmFnZ2luZyA9IGZ1bmN0aW9uIGlzRHJhZ2dpbmcobW9uaXRvciwgaGFuZGxlKSB7XG4gICAgcmV0dXJuIGhhbmRsZSA9PT0gbW9uaXRvci5nZXRTb3VyY2VJZCgpO1xuICB9O1xuXG4gIERyYWdTb3VyY2UucHJvdG90eXBlLmVuZERyYWcgPSBmdW5jdGlvbiBlbmREcmFnKCkge307XG5cbiAgcmV0dXJuIERyYWdTb3VyY2U7XG59KSgpO1xuXG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IERyYWdTb3VyY2U7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbXCJkZWZhdWx0XCJdOyIsIlwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgRHJvcFRhcmdldCA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIERyb3BUYXJnZXQoKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIERyb3BUYXJnZXQpO1xuICB9XG5cbiAgRHJvcFRhcmdldC5wcm90b3R5cGUuY2FuRHJvcCA9IGZ1bmN0aW9uIGNhbkRyb3AoKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG5cbiAgRHJvcFRhcmdldC5wcm90b3R5cGUuaG92ZXIgPSBmdW5jdGlvbiBob3ZlcigpIHt9O1xuXG4gIERyb3BUYXJnZXQucHJvdG90eXBlLmRyb3AgPSBmdW5jdGlvbiBkcm9wKCkge307XG5cbiAgcmV0dXJuIERyb3BUYXJnZXQ7XG59KSgpO1xuXG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IERyb3BUYXJnZXQ7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbXCJkZWZhdWx0XCJdOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH1cblxuZnVuY3Rpb24gX3R5cGVvZihvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouY29uc3RydWN0b3IgPT09IFN5bWJvbCA/ICdzeW1ib2wnIDogdHlwZW9mIG9iajsgfVxuXG52YXIgX2ludmFyaWFudCA9IHJlcXVpcmUoJ2ludmFyaWFudCcpO1xuXG52YXIgX2ludmFyaWFudDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9pbnZhcmlhbnQpO1xuXG52YXIgX2xvZGFzaElzQXJyYXkgPSByZXF1aXJlKCdsb2Rhc2gvaXNBcnJheScpO1xuXG52YXIgX2xvZGFzaElzQXJyYXkyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNBcnJheSk7XG5cbnZhciBfdXRpbHNHZXROZXh0VW5pcXVlSWQgPSByZXF1aXJlKCcuL3V0aWxzL2dldE5leHRVbmlxdWVJZCcpO1xuXG52YXIgX3V0aWxzR2V0TmV4dFVuaXF1ZUlkMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3V0aWxzR2V0TmV4dFVuaXF1ZUlkKTtcblxudmFyIF9hY3Rpb25zUmVnaXN0cnkgPSByZXF1aXJlKCcuL2FjdGlvbnMvcmVnaXN0cnknKTtcblxudmFyIF9hc2FwID0gcmVxdWlyZSgnYXNhcCcpO1xuXG52YXIgX2FzYXAyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfYXNhcCk7XG5cbnZhciBIYW5kbGVyUm9sZXMgPSB7XG4gIFNPVVJDRTogJ1NPVVJDRScsXG4gIFRBUkdFVDogJ1RBUkdFVCdcbn07XG5cbmZ1bmN0aW9uIHZhbGlkYXRlU291cmNlQ29udHJhY3Qoc291cmNlKSB7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIHNvdXJjZS5jYW5EcmFnID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgY2FuRHJhZyB0byBiZSBhIGZ1bmN0aW9uLicpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBzb3VyY2UuYmVnaW5EcmFnID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgYmVnaW5EcmFnIHRvIGJlIGEgZnVuY3Rpb24uJyk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIHNvdXJjZS5lbmREcmFnID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgZW5kRHJhZyB0byBiZSBhIGZ1bmN0aW9uLicpO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVRhcmdldENvbnRyYWN0KHRhcmdldCkge1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiB0YXJnZXQuY2FuRHJvcCA9PT0gJ2Z1bmN0aW9uJywgJ0V4cGVjdGVkIGNhbkRyb3AgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0eXBlb2YgdGFyZ2V0LmhvdmVyID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgaG92ZXIgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0eXBlb2YgdGFyZ2V0LmRyb3AgPT09ICdmdW5jdGlvbicsICdFeHBlY3RlZCBiZWdpbkRyYWcgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVUeXBlKHR5cGUsIGFsbG93QXJyYXkpIHtcbiAgaWYgKGFsbG93QXJyYXkgJiYgX2xvZGFzaElzQXJyYXkyWydkZWZhdWx0J10odHlwZSkpIHtcbiAgICB0eXBlLmZvckVhY2goZnVuY3Rpb24gKHQpIHtcbiAgICAgIHJldHVybiB2YWxpZGF0ZVR5cGUodCwgZmFsc2UpO1xuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIHR5cGUgPT09ICdzdHJpbmcnIHx8ICh0eXBlb2YgdHlwZSA9PT0gJ3VuZGVmaW5lZCcgPyAndW5kZWZpbmVkJyA6IF90eXBlb2YodHlwZSkpID09PSAnc3ltYm9sJywgYWxsb3dBcnJheSA/ICdUeXBlIGNhbiBvbmx5IGJlIGEgc3RyaW5nLCBhIHN5bWJvbCwgb3IgYW4gYXJyYXkgb2YgZWl0aGVyLicgOiAnVHlwZSBjYW4gb25seSBiZSBhIHN0cmluZyBvciBhIHN5bWJvbC4nKTtcbn1cblxuZnVuY3Rpb24gZ2V0TmV4dEhhbmRsZXJJZChyb2xlKSB7XG4gIHZhciBpZCA9IF91dGlsc0dldE5leHRVbmlxdWVJZDJbJ2RlZmF1bHQnXSgpLnRvU3RyaW5nKCk7XG4gIHN3aXRjaCAocm9sZSkge1xuICAgIGNhc2UgSGFuZGxlclJvbGVzLlNPVVJDRTpcbiAgICAgIHJldHVybiAnUycgKyBpZDtcbiAgICBjYXNlIEhhbmRsZXJSb2xlcy5UQVJHRVQ6XG4gICAgICByZXR1cm4gJ1QnICsgaWQ7XG4gICAgZGVmYXVsdDpcbiAgICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oZmFsc2UsICdVbmtub3duIHJvbGU6ICcgKyByb2xlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVJvbGVGcm9tSGFuZGxlcklkKGhhbmRsZXJJZCkge1xuICBzd2l0Y2ggKGhhbmRsZXJJZFswXSkge1xuICAgIGNhc2UgJ1MnOlxuICAgICAgcmV0dXJuIEhhbmRsZXJSb2xlcy5TT1VSQ0U7XG4gICAgY2FzZSAnVCc6XG4gICAgICByZXR1cm4gSGFuZGxlclJvbGVzLlRBUkdFVDtcbiAgICBkZWZhdWx0OlxuICAgICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShmYWxzZSwgJ0Nhbm5vdCBwYXJzZSBoYW5kbGVyIElEOiAnICsgaGFuZGxlcklkKTtcbiAgfVxufVxuXG52YXIgSGFuZGxlclJlZ2lzdHJ5ID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gSGFuZGxlclJlZ2lzdHJ5KHN0b3JlKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIEhhbmRsZXJSZWdpc3RyeSk7XG5cbiAgICB0aGlzLnN0b3JlID0gc3RvcmU7XG5cbiAgICB0aGlzLnR5cGVzID0ge307XG4gICAgdGhpcy5oYW5kbGVycyA9IHt9O1xuXG4gICAgdGhpcy5waW5uZWRTb3VyY2VJZCA9IG51bGw7XG4gICAgdGhpcy5waW5uZWRTb3VyY2UgPSBudWxsO1xuICB9XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5hZGRTb3VyY2UgPSBmdW5jdGlvbiBhZGRTb3VyY2UodHlwZSwgc291cmNlKSB7XG4gICAgdmFsaWRhdGVUeXBlKHR5cGUpO1xuICAgIHZhbGlkYXRlU291cmNlQ29udHJhY3Qoc291cmNlKTtcblxuICAgIHZhciBzb3VyY2VJZCA9IHRoaXMuYWRkSGFuZGxlcihIYW5kbGVyUm9sZXMuU09VUkNFLCB0eXBlLCBzb3VyY2UpO1xuICAgIHRoaXMuc3RvcmUuZGlzcGF0Y2goX2FjdGlvbnNSZWdpc3RyeS5hZGRTb3VyY2Uoc291cmNlSWQpKTtcbiAgICByZXR1cm4gc291cmNlSWQ7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5hZGRUYXJnZXQgPSBmdW5jdGlvbiBhZGRUYXJnZXQodHlwZSwgdGFyZ2V0KSB7XG4gICAgdmFsaWRhdGVUeXBlKHR5cGUsIHRydWUpO1xuICAgIHZhbGlkYXRlVGFyZ2V0Q29udHJhY3QodGFyZ2V0KTtcblxuICAgIHZhciB0YXJnZXRJZCA9IHRoaXMuYWRkSGFuZGxlcihIYW5kbGVyUm9sZXMuVEFSR0VULCB0eXBlLCB0YXJnZXQpO1xuICAgIHRoaXMuc3RvcmUuZGlzcGF0Y2goX2FjdGlvbnNSZWdpc3RyeS5hZGRUYXJnZXQodGFyZ2V0SWQpKTtcbiAgICByZXR1cm4gdGFyZ2V0SWQ7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5hZGRIYW5kbGVyID0gZnVuY3Rpb24gYWRkSGFuZGxlcihyb2xlLCB0eXBlLCBoYW5kbGVyKSB7XG4gICAgdmFyIGlkID0gZ2V0TmV4dEhhbmRsZXJJZChyb2xlKTtcbiAgICB0aGlzLnR5cGVzW2lkXSA9IHR5cGU7XG4gICAgdGhpcy5oYW5kbGVyc1tpZF0gPSBoYW5kbGVyO1xuXG4gICAgcmV0dXJuIGlkO1xuICB9O1xuXG4gIEhhbmRsZXJSZWdpc3RyeS5wcm90b3R5cGUuY29udGFpbnNIYW5kbGVyID0gZnVuY3Rpb24gY29udGFpbnNIYW5kbGVyKGhhbmRsZXIpIHtcbiAgICB2YXIgX3RoaXMgPSB0aGlzO1xuXG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRoaXMuaGFuZGxlcnMpLnNvbWUoZnVuY3Rpb24gKGtleSkge1xuICAgICAgcmV0dXJuIF90aGlzLmhhbmRsZXJzW2tleV0gPT09IGhhbmRsZXI7XG4gICAgfSk7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5nZXRTb3VyY2UgPSBmdW5jdGlvbiBnZXRTb3VyY2Uoc291cmNlSWQsIGluY2x1ZGVQaW5uZWQpIHtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHRoaXMuaXNTb3VyY2VJZChzb3VyY2VJZCksICdFeHBlY3RlZCBhIHZhbGlkIHNvdXJjZSBJRC4nKTtcblxuICAgIHZhciBpc1Bpbm5lZCA9IGluY2x1ZGVQaW5uZWQgJiYgc291cmNlSWQgPT09IHRoaXMucGlubmVkU291cmNlSWQ7XG4gICAgdmFyIHNvdXJjZSA9IGlzUGlubmVkID8gdGhpcy5waW5uZWRTb3VyY2UgOiB0aGlzLmhhbmRsZXJzW3NvdXJjZUlkXTtcblxuICAgIHJldHVybiBzb3VyY2U7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5nZXRUYXJnZXQgPSBmdW5jdGlvbiBnZXRUYXJnZXQodGFyZ2V0SWQpIHtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHRoaXMuaXNUYXJnZXRJZCh0YXJnZXRJZCksICdFeHBlY3RlZCBhIHZhbGlkIHRhcmdldCBJRC4nKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVyc1t0YXJnZXRJZF07XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5nZXRTb3VyY2VUeXBlID0gZnVuY3Rpb24gZ2V0U291cmNlVHlwZShzb3VyY2VJZCkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odGhpcy5pc1NvdXJjZUlkKHNvdXJjZUlkKSwgJ0V4cGVjdGVkIGEgdmFsaWQgc291cmNlIElELicpO1xuICAgIHJldHVybiB0aGlzLnR5cGVzW3NvdXJjZUlkXTtcbiAgfTtcblxuICBIYW5kbGVyUmVnaXN0cnkucHJvdG90eXBlLmdldFRhcmdldFR5cGUgPSBmdW5jdGlvbiBnZXRUYXJnZXRUeXBlKHRhcmdldElkKSB7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0aGlzLmlzVGFyZ2V0SWQodGFyZ2V0SWQpLCAnRXhwZWN0ZWQgYSB2YWxpZCB0YXJnZXQgSUQuJyk7XG4gICAgcmV0dXJuIHRoaXMudHlwZXNbdGFyZ2V0SWRdO1xuICB9O1xuXG4gIEhhbmRsZXJSZWdpc3RyeS5wcm90b3R5cGUuaXNTb3VyY2VJZCA9IGZ1bmN0aW9uIGlzU291cmNlSWQoaGFuZGxlcklkKSB7XG4gICAgdmFyIHJvbGUgPSBwYXJzZVJvbGVGcm9tSGFuZGxlcklkKGhhbmRsZXJJZCk7XG4gICAgcmV0dXJuIHJvbGUgPT09IEhhbmRsZXJSb2xlcy5TT1VSQ0U7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS5pc1RhcmdldElkID0gZnVuY3Rpb24gaXNUYXJnZXRJZChoYW5kbGVySWQpIHtcbiAgICB2YXIgcm9sZSA9IHBhcnNlUm9sZUZyb21IYW5kbGVySWQoaGFuZGxlcklkKTtcbiAgICByZXR1cm4gcm9sZSA9PT0gSGFuZGxlclJvbGVzLlRBUkdFVDtcbiAgfTtcblxuICBIYW5kbGVyUmVnaXN0cnkucHJvdG90eXBlLnJlbW92ZVNvdXJjZSA9IGZ1bmN0aW9uIHJlbW92ZVNvdXJjZShzb3VyY2VJZCkge1xuICAgIHZhciBfdGhpczIgPSB0aGlzO1xuXG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0aGlzLmdldFNvdXJjZShzb3VyY2VJZCksICdFeHBlY3RlZCBhbiBleGlzdGluZyBzb3VyY2UuJyk7XG4gICAgdGhpcy5zdG9yZS5kaXNwYXRjaChfYWN0aW9uc1JlZ2lzdHJ5LnJlbW92ZVNvdXJjZShzb3VyY2VJZCkpO1xuXG4gICAgX2FzYXAyWydkZWZhdWx0J10oZnVuY3Rpb24gKCkge1xuICAgICAgZGVsZXRlIF90aGlzMi5oYW5kbGVyc1tzb3VyY2VJZF07XG4gICAgICBkZWxldGUgX3RoaXMyLnR5cGVzW3NvdXJjZUlkXTtcbiAgICB9KTtcbiAgfTtcblxuICBIYW5kbGVyUmVnaXN0cnkucHJvdG90eXBlLnJlbW92ZVRhcmdldCA9IGZ1bmN0aW9uIHJlbW92ZVRhcmdldCh0YXJnZXRJZCkge1xuICAgIHZhciBfdGhpczMgPSB0aGlzO1xuXG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0aGlzLmdldFRhcmdldCh0YXJnZXRJZCksICdFeHBlY3RlZCBhbiBleGlzdGluZyB0YXJnZXQuJyk7XG4gICAgdGhpcy5zdG9yZS5kaXNwYXRjaChfYWN0aW9uc1JlZ2lzdHJ5LnJlbW92ZVRhcmdldCh0YXJnZXRJZCkpO1xuXG4gICAgX2FzYXAyWydkZWZhdWx0J10oZnVuY3Rpb24gKCkge1xuICAgICAgZGVsZXRlIF90aGlzMy5oYW5kbGVyc1t0YXJnZXRJZF07XG4gICAgICBkZWxldGUgX3RoaXMzLnR5cGVzW3RhcmdldElkXTtcbiAgICB9KTtcbiAgfTtcblxuICBIYW5kbGVyUmVnaXN0cnkucHJvdG90eXBlLnBpblNvdXJjZSA9IGZ1bmN0aW9uIHBpblNvdXJjZShzb3VyY2VJZCkge1xuICAgIHZhciBzb3VyY2UgPSB0aGlzLmdldFNvdXJjZShzb3VyY2VJZCk7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShzb3VyY2UsICdFeHBlY3RlZCBhbiBleGlzdGluZyBzb3VyY2UuJyk7XG5cbiAgICB0aGlzLnBpbm5lZFNvdXJjZUlkID0gc291cmNlSWQ7XG4gICAgdGhpcy5waW5uZWRTb3VyY2UgPSBzb3VyY2U7XG4gIH07XG5cbiAgSGFuZGxlclJlZ2lzdHJ5LnByb3RvdHlwZS51bnBpblNvdXJjZSA9IGZ1bmN0aW9uIHVucGluU291cmNlKCkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odGhpcy5waW5uZWRTb3VyY2UsICdObyBzb3VyY2UgaXMgcGlubmVkIGF0IHRoZSB0aW1lLicpO1xuXG4gICAgdGhpcy5waW5uZWRTb3VyY2VJZCA9IG51bGw7XG4gICAgdGhpcy5waW5uZWRTb3VyY2UgPSBudWxsO1xuICB9O1xuXG4gIHJldHVybiBIYW5kbGVyUmVnaXN0cnk7XG59KSgpO1xuXG5leHBvcnRzWydkZWZhdWx0J10gPSBIYW5kbGVyUmVnaXN0cnk7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLmJlZ2luRHJhZyA9IGJlZ2luRHJhZztcbmV4cG9ydHMucHVibGlzaERyYWdTb3VyY2UgPSBwdWJsaXNoRHJhZ1NvdXJjZTtcbmV4cG9ydHMuaG92ZXIgPSBob3ZlcjtcbmV4cG9ydHMuZHJvcCA9IGRyb3A7XG5leHBvcnRzLmVuZERyYWcgPSBlbmREcmFnO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfdXRpbHNNYXRjaGVzVHlwZSA9IHJlcXVpcmUoJy4uL3V0aWxzL21hdGNoZXNUeXBlJyk7XG5cbnZhciBfdXRpbHNNYXRjaGVzVHlwZTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc01hdGNoZXNUeXBlKTtcblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIF9sb2Rhc2hJc0FycmF5ID0gcmVxdWlyZSgnbG9kYXNoL2lzQXJyYXknKTtcblxudmFyIF9sb2Rhc2hJc0FycmF5MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaElzQXJyYXkpO1xuXG52YXIgX2xvZGFzaElzT2JqZWN0ID0gcmVxdWlyZSgnbG9kYXNoL2lzT2JqZWN0Jyk7XG5cbnZhciBfbG9kYXNoSXNPYmplY3QyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNPYmplY3QpO1xuXG52YXIgQkVHSU5fRFJBRyA9ICdkbmQtY29yZS9CRUdJTl9EUkFHJztcbmV4cG9ydHMuQkVHSU5fRFJBRyA9IEJFR0lOX0RSQUc7XG52YXIgUFVCTElTSF9EUkFHX1NPVVJDRSA9ICdkbmQtY29yZS9QVUJMSVNIX0RSQUdfU09VUkNFJztcbmV4cG9ydHMuUFVCTElTSF9EUkFHX1NPVVJDRSA9IFBVQkxJU0hfRFJBR19TT1VSQ0U7XG52YXIgSE9WRVIgPSAnZG5kLWNvcmUvSE9WRVInO1xuZXhwb3J0cy5IT1ZFUiA9IEhPVkVSO1xudmFyIERST1AgPSAnZG5kLWNvcmUvRFJPUCc7XG5leHBvcnRzLkRST1AgPSBEUk9QO1xudmFyIEVORF9EUkFHID0gJ2RuZC1jb3JlL0VORF9EUkFHJztcblxuZXhwb3J0cy5FTkRfRFJBRyA9IEVORF9EUkFHO1xuXG5mdW5jdGlvbiBiZWdpbkRyYWcoc291cmNlSWRzKSB7XG4gIHZhciBfcmVmID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbMV07XG5cbiAgdmFyIF9yZWYkcHVibGlzaFNvdXJjZSA9IF9yZWYucHVibGlzaFNvdXJjZTtcbiAgdmFyIHB1Ymxpc2hTb3VyY2UgPSBfcmVmJHB1Ymxpc2hTb3VyY2UgPT09IHVuZGVmaW5lZCA/IHRydWUgOiBfcmVmJHB1Ymxpc2hTb3VyY2U7XG4gIHZhciBfcmVmJGNsaWVudE9mZnNldCA9IF9yZWYuY2xpZW50T2Zmc2V0O1xuICB2YXIgY2xpZW50T2Zmc2V0ID0gX3JlZiRjbGllbnRPZmZzZXQgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBfcmVmJGNsaWVudE9mZnNldDtcbiAgdmFyIGdldFNvdXJjZUNsaWVudE9mZnNldCA9IF9yZWYuZ2V0U291cmNlQ2xpZW50T2Zmc2V0O1xuXG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oX2xvZGFzaElzQXJyYXkyWydkZWZhdWx0J10oc291cmNlSWRzKSwgJ0V4cGVjdGVkIHNvdXJjZUlkcyB0byBiZSBhbiBhcnJheS4nKTtcblxuICB2YXIgbW9uaXRvciA9IHRoaXMuZ2V0TW9uaXRvcigpO1xuICB2YXIgcmVnaXN0cnkgPSB0aGlzLmdldFJlZ2lzdHJ5KCk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIW1vbml0b3IuaXNEcmFnZ2luZygpLCAnQ2Fubm90IGNhbGwgYmVnaW5EcmFnIHdoaWxlIGRyYWdnaW5nLicpO1xuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgc291cmNlSWRzLmxlbmd0aDsgaSsrKSB7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShyZWdpc3RyeS5nZXRTb3VyY2Uoc291cmNlSWRzW2ldKSwgJ0V4cGVjdGVkIHNvdXJjZUlkcyB0byBiZSByZWdpc3RlcmVkLicpO1xuICB9XG5cbiAgdmFyIHNvdXJjZUlkID0gbnVsbDtcbiAgZm9yICh2YXIgaSA9IHNvdXJjZUlkcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGlmIChtb25pdG9yLmNhbkRyYWdTb3VyY2Uoc291cmNlSWRzW2ldKSkge1xuICAgICAgc291cmNlSWQgPSBzb3VyY2VJZHNbaV07XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgaWYgKHNvdXJjZUlkID09PSBudWxsKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHNvdXJjZUNsaWVudE9mZnNldCA9IG51bGw7XG4gIGlmIChjbGllbnRPZmZzZXQpIHtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBnZXRTb3VyY2VDbGllbnRPZmZzZXQgPT09ICdmdW5jdGlvbicsICdXaGVuIGNsaWVudE9mZnNldCBpcyBwcm92aWRlZCwgZ2V0U291cmNlQ2xpZW50T2Zmc2V0IG11c3QgYmUgYSBmdW5jdGlvbi4nKTtcbiAgICBzb3VyY2VDbGllbnRPZmZzZXQgPSBnZXRTb3VyY2VDbGllbnRPZmZzZXQoc291cmNlSWQpO1xuICB9XG5cbiAgdmFyIHNvdXJjZSA9IHJlZ2lzdHJ5LmdldFNvdXJjZShzb3VyY2VJZCk7XG4gIHZhciBpdGVtID0gc291cmNlLmJlZ2luRHJhZyhtb25pdG9yLCBzb3VyY2VJZCk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oX2xvZGFzaElzT2JqZWN0MlsnZGVmYXVsdCddKGl0ZW0pLCAnSXRlbSBtdXN0IGJlIGFuIG9iamVjdC4nKTtcblxuICByZWdpc3RyeS5waW5Tb3VyY2Uoc291cmNlSWQpO1xuXG4gIHZhciBpdGVtVHlwZSA9IHJlZ2lzdHJ5LmdldFNvdXJjZVR5cGUoc291cmNlSWQpO1xuICByZXR1cm4ge1xuICAgIHR5cGU6IEJFR0lOX0RSQUcsXG4gICAgaXRlbVR5cGU6IGl0ZW1UeXBlLFxuICAgIGl0ZW06IGl0ZW0sXG4gICAgc291cmNlSWQ6IHNvdXJjZUlkLFxuICAgIGNsaWVudE9mZnNldDogY2xpZW50T2Zmc2V0LFxuICAgIHNvdXJjZUNsaWVudE9mZnNldDogc291cmNlQ2xpZW50T2Zmc2V0LFxuICAgIGlzU291cmNlUHVibGljOiBwdWJsaXNoU291cmNlXG4gIH07XG59XG5cbmZ1bmN0aW9uIHB1Ymxpc2hEcmFnU291cmNlKG1hbmFnZXIpIHtcbiAgdmFyIG1vbml0b3IgPSB0aGlzLmdldE1vbml0b3IoKTtcbiAgaWYgKCFtb25pdG9yLmlzRHJhZ2dpbmcoKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdHlwZTogUFVCTElTSF9EUkFHX1NPVVJDRVxuICB9O1xufVxuXG5mdW5jdGlvbiBob3Zlcih0YXJnZXRJZHMpIHtcbiAgdmFyIF9yZWYyID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbMV07XG5cbiAgdmFyIF9yZWYyJGNsaWVudE9mZnNldCA9IF9yZWYyLmNsaWVudE9mZnNldDtcbiAgdmFyIGNsaWVudE9mZnNldCA9IF9yZWYyJGNsaWVudE9mZnNldCA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IF9yZWYyJGNsaWVudE9mZnNldDtcblxuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc0FycmF5MlsnZGVmYXVsdCddKHRhcmdldElkcyksICdFeHBlY3RlZCB0YXJnZXRJZHMgdG8gYmUgYW4gYXJyYXkuJyk7XG4gIHRhcmdldElkcyA9IHRhcmdldElkcy5zbGljZSgwKTtcblxuICB2YXIgbW9uaXRvciA9IHRoaXMuZ2V0TW9uaXRvcigpO1xuICB2YXIgcmVnaXN0cnkgPSB0aGlzLmdldFJlZ2lzdHJ5KCk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10obW9uaXRvci5pc0RyYWdnaW5nKCksICdDYW5ub3QgY2FsbCBob3ZlciB3aGlsZSBub3QgZHJhZ2dpbmcuJyk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIW1vbml0b3IuZGlkRHJvcCgpLCAnQ2Fubm90IGNhbGwgaG92ZXIgYWZ0ZXIgZHJvcC4nKTtcblxuICAvLyBGaXJzdCBjaGVjayBpbnZhcmlhbnRzLlxuICBmb3IgKHZhciBpID0gMDsgaSA8IHRhcmdldElkcy5sZW5ndGg7IGkrKykge1xuICAgIHZhciB0YXJnZXRJZCA9IHRhcmdldElkc1tpXTtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHRhcmdldElkcy5sYXN0SW5kZXhPZih0YXJnZXRJZCkgPT09IGksICdFeHBlY3RlZCB0YXJnZXRJZHMgdG8gYmUgdW5pcXVlIGluIHRoZSBwYXNzZWQgYXJyYXkuJyk7XG5cbiAgICB2YXIgdGFyZ2V0ID0gcmVnaXN0cnkuZ2V0VGFyZ2V0KHRhcmdldElkKTtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHRhcmdldCwgJ0V4cGVjdGVkIHRhcmdldElkcyB0byBiZSByZWdpc3RlcmVkLicpO1xuICB9XG5cbiAgdmFyIGRyYWdnZWRJdGVtVHlwZSA9IG1vbml0b3IuZ2V0SXRlbVR5cGUoKTtcblxuICAvLyBSZW1vdmUgdGhvc2UgdGFyZ2V0SWRzIHRoYXQgZG9uJ3QgbWF0Y2ggdGhlIHRhcmdldFR5cGUuICBUaGlzXG4gIC8vIGZpeGVzIHNoYWxsb3cgaXNPdmVyIHdoaWNoIHdvdWxkIG9ubHkgYmUgbm9uLXNoYWxsb3cgYmVjYXVzZSBvZlxuICAvLyBub24tbWF0Y2hpbmcgdGFyZ2V0cy5cbiAgZm9yICh2YXIgaSA9IHRhcmdldElkcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIHZhciB0YXJnZXRJZCA9IHRhcmdldElkc1tpXTtcbiAgICB2YXIgdGFyZ2V0VHlwZSA9IHJlZ2lzdHJ5LmdldFRhcmdldFR5cGUodGFyZ2V0SWQpO1xuICAgIGlmICghX3V0aWxzTWF0Y2hlc1R5cGUyWydkZWZhdWx0J10odGFyZ2V0VHlwZSwgZHJhZ2dlZEl0ZW1UeXBlKSkge1xuICAgICAgdGFyZ2V0SWRzLnNwbGljZShpLCAxKTtcbiAgICB9XG4gIH1cblxuICAvLyBGaW5hbGx5IGNhbGwgaG92ZXIgb24gYWxsIG1hdGNoaW5nIHRhcmdldHMuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdGFyZ2V0SWRzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHRhcmdldElkID0gdGFyZ2V0SWRzW2ldO1xuICAgIHZhciB0YXJnZXQgPSByZWdpc3RyeS5nZXRUYXJnZXQodGFyZ2V0SWQpO1xuICAgIHRhcmdldC5ob3Zlcihtb25pdG9yLCB0YXJnZXRJZCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHR5cGU6IEhPVkVSLFxuICAgIHRhcmdldElkczogdGFyZ2V0SWRzLFxuICAgIGNsaWVudE9mZnNldDogY2xpZW50T2Zmc2V0XG4gIH07XG59XG5cbmZ1bmN0aW9uIGRyb3AoKSB7XG4gIHZhciBfdGhpcyA9IHRoaXM7XG5cbiAgdmFyIG1vbml0b3IgPSB0aGlzLmdldE1vbml0b3IoKTtcbiAgdmFyIHJlZ2lzdHJ5ID0gdGhpcy5nZXRSZWdpc3RyeSgpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKG1vbml0b3IuaXNEcmFnZ2luZygpLCAnQ2Fubm90IGNhbGwgZHJvcCB3aGlsZSBub3QgZHJhZ2dpbmcuJyk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIW1vbml0b3IuZGlkRHJvcCgpLCAnQ2Fubm90IGNhbGwgZHJvcCB0d2ljZSBkdXJpbmcgb25lIGRyYWcgb3BlcmF0aW9uLicpO1xuXG4gIHZhciB0YXJnZXRJZHMgPSBtb25pdG9yLmdldFRhcmdldElkcygpLmZpbHRlcihtb25pdG9yLmNhbkRyb3BPblRhcmdldCwgbW9uaXRvcik7XG5cbiAgdGFyZ2V0SWRzLnJldmVyc2UoKTtcbiAgdGFyZ2V0SWRzLmZvckVhY2goZnVuY3Rpb24gKHRhcmdldElkLCBpbmRleCkge1xuICAgIHZhciB0YXJnZXQgPSByZWdpc3RyeS5nZXRUYXJnZXQodGFyZ2V0SWQpO1xuXG4gICAgdmFyIGRyb3BSZXN1bHQgPSB0YXJnZXQuZHJvcChtb25pdG9yLCB0YXJnZXRJZCk7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0eXBlb2YgZHJvcFJlc3VsdCA9PT0gJ3VuZGVmaW5lZCcgfHwgX2xvZGFzaElzT2JqZWN0MlsnZGVmYXVsdCddKGRyb3BSZXN1bHQpLCAnRHJvcCByZXN1bHQgbXVzdCBlaXRoZXIgYmUgYW4gb2JqZWN0IG9yIHVuZGVmaW5lZC4nKTtcbiAgICBpZiAodHlwZW9mIGRyb3BSZXN1bHQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBkcm9wUmVzdWx0ID0gaW5kZXggPT09IDAgPyB7fSA6IG1vbml0b3IuZ2V0RHJvcFJlc3VsdCgpO1xuICAgIH1cblxuICAgIF90aGlzLnN0b3JlLmRpc3BhdGNoKHtcbiAgICAgIHR5cGU6IERST1AsXG4gICAgICBkcm9wUmVzdWx0OiBkcm9wUmVzdWx0XG4gICAgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBlbmREcmFnKCkge1xuICB2YXIgbW9uaXRvciA9IHRoaXMuZ2V0TW9uaXRvcigpO1xuICB2YXIgcmVnaXN0cnkgPSB0aGlzLmdldFJlZ2lzdHJ5KCk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10obW9uaXRvci5pc0RyYWdnaW5nKCksICdDYW5ub3QgY2FsbCBlbmREcmFnIHdoaWxlIG5vdCBkcmFnZ2luZy4nKTtcblxuICB2YXIgc291cmNlSWQgPSBtb25pdG9yLmdldFNvdXJjZUlkKCk7XG4gIHZhciBzb3VyY2UgPSByZWdpc3RyeS5nZXRTb3VyY2Uoc291cmNlSWQsIHRydWUpO1xuICBzb3VyY2UuZW5kRHJhZyhtb25pdG9yLCBzb3VyY2VJZCk7XG5cbiAgcmVnaXN0cnkudW5waW5Tb3VyY2UoKTtcblxuICByZXR1cm4ge1xuICAgIHR5cGU6IEVORF9EUkFHXG4gIH07XG59IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5hZGRTb3VyY2UgPSBhZGRTb3VyY2U7XG5leHBvcnRzLmFkZFRhcmdldCA9IGFkZFRhcmdldDtcbmV4cG9ydHMucmVtb3ZlU291cmNlID0gcmVtb3ZlU291cmNlO1xuZXhwb3J0cy5yZW1vdmVUYXJnZXQgPSByZW1vdmVUYXJnZXQ7XG52YXIgQUREX1NPVVJDRSA9ICdkbmQtY29yZS9BRERfU09VUkNFJztcbmV4cG9ydHMuQUREX1NPVVJDRSA9IEFERF9TT1VSQ0U7XG52YXIgQUREX1RBUkdFVCA9ICdkbmQtY29yZS9BRERfVEFSR0VUJztcbmV4cG9ydHMuQUREX1RBUkdFVCA9IEFERF9UQVJHRVQ7XG52YXIgUkVNT1ZFX1NPVVJDRSA9ICdkbmQtY29yZS9SRU1PVkVfU09VUkNFJztcbmV4cG9ydHMuUkVNT1ZFX1NPVVJDRSA9IFJFTU9WRV9TT1VSQ0U7XG52YXIgUkVNT1ZFX1RBUkdFVCA9ICdkbmQtY29yZS9SRU1PVkVfVEFSR0VUJztcblxuZXhwb3J0cy5SRU1PVkVfVEFSR0VUID0gUkVNT1ZFX1RBUkdFVDtcblxuZnVuY3Rpb24gYWRkU291cmNlKHNvdXJjZUlkKSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogQUREX1NPVVJDRSxcbiAgICBzb3VyY2VJZDogc291cmNlSWRcbiAgfTtcbn1cblxuZnVuY3Rpb24gYWRkVGFyZ2V0KHRhcmdldElkKSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogQUREX1RBUkdFVCxcbiAgICB0YXJnZXRJZDogdGFyZ2V0SWRcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlU291cmNlKHNvdXJjZUlkKSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogUkVNT1ZFX1NPVVJDRSxcbiAgICBzb3VyY2VJZDogc291cmNlSWRcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlVGFyZ2V0KHRhcmdldElkKSB7XG4gIHJldHVybiB7XG4gICAgdHlwZTogUkVNT1ZFX1RBUkdFVCxcbiAgICB0YXJnZXRJZDogdGFyZ2V0SWRcbiAgfTtcbn0iLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBjcmVhdGVCYWNrZW5kO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcignQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uJyk7IH0gfVxuXG52YXIgX2xvZGFzaE5vb3AgPSByZXF1aXJlKCdsb2Rhc2gvbm9vcCcpO1xuXG52YXIgX2xvZGFzaE5vb3AyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoTm9vcCk7XG5cbnZhciBUZXN0QmFja2VuZCA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIFRlc3RCYWNrZW5kKG1hbmFnZXIpIHtcbiAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgVGVzdEJhY2tlbmQpO1xuXG4gICAgdGhpcy5hY3Rpb25zID0gbWFuYWdlci5nZXRBY3Rpb25zKCk7XG4gIH1cblxuICBUZXN0QmFja2VuZC5wcm90b3R5cGUuc2V0dXAgPSBmdW5jdGlvbiBzZXR1cCgpIHtcbiAgICB0aGlzLmRpZENhbGxTZXR1cCA9IHRydWU7XG4gIH07XG5cbiAgVGVzdEJhY2tlbmQucHJvdG90eXBlLnRlYXJkb3duID0gZnVuY3Rpb24gdGVhcmRvd24oKSB7XG4gICAgdGhpcy5kaWRDYWxsVGVhcmRvd24gPSB0cnVlO1xuICB9O1xuXG4gIFRlc3RCYWNrZW5kLnByb3RvdHlwZS5jb25uZWN0RHJhZ1NvdXJjZSA9IGZ1bmN0aW9uIGNvbm5lY3REcmFnU291cmNlKCkge1xuICAgIHJldHVybiBfbG9kYXNoTm9vcDJbJ2RlZmF1bHQnXTtcbiAgfTtcblxuICBUZXN0QmFja2VuZC5wcm90b3R5cGUuY29ubmVjdERyYWdQcmV2aWV3ID0gZnVuY3Rpb24gY29ubmVjdERyYWdQcmV2aWV3KCkge1xuICAgIHJldHVybiBfbG9kYXNoTm9vcDJbJ2RlZmF1bHQnXTtcbiAgfTtcblxuICBUZXN0QmFja2VuZC5wcm90b3R5cGUuY29ubmVjdERyb3BUYXJnZXQgPSBmdW5jdGlvbiBjb25uZWN0RHJvcFRhcmdldCgpIHtcbiAgICByZXR1cm4gX2xvZGFzaE5vb3AyWydkZWZhdWx0J107XG4gIH07XG5cbiAgVGVzdEJhY2tlbmQucHJvdG90eXBlLnNpbXVsYXRlQmVnaW5EcmFnID0gZnVuY3Rpb24gc2ltdWxhdGVCZWdpbkRyYWcoc291cmNlSWRzLCBvcHRpb25zKSB7XG4gICAgdGhpcy5hY3Rpb25zLmJlZ2luRHJhZyhzb3VyY2VJZHMsIG9wdGlvbnMpO1xuICB9O1xuXG4gIFRlc3RCYWNrZW5kLnByb3RvdHlwZS5zaW11bGF0ZVB1Ymxpc2hEcmFnU291cmNlID0gZnVuY3Rpb24gc2ltdWxhdGVQdWJsaXNoRHJhZ1NvdXJjZSgpIHtcbiAgICB0aGlzLmFjdGlvbnMucHVibGlzaERyYWdTb3VyY2UoKTtcbiAgfTtcblxuICBUZXN0QmFja2VuZC5wcm90b3R5cGUuc2ltdWxhdGVIb3ZlciA9IGZ1bmN0aW9uIHNpbXVsYXRlSG92ZXIodGFyZ2V0SWRzLCBvcHRpb25zKSB7XG4gICAgdGhpcy5hY3Rpb25zLmhvdmVyKHRhcmdldElkcywgb3B0aW9ucyk7XG4gIH07XG5cbiAgVGVzdEJhY2tlbmQucHJvdG90eXBlLnNpbXVsYXRlRHJvcCA9IGZ1bmN0aW9uIHNpbXVsYXRlRHJvcCgpIHtcbiAgICB0aGlzLmFjdGlvbnMuZHJvcCgpO1xuICB9O1xuXG4gIFRlc3RCYWNrZW5kLnByb3RvdHlwZS5zaW11bGF0ZUVuZERyYWcgPSBmdW5jdGlvbiBzaW11bGF0ZUVuZERyYWcoKSB7XG4gICAgdGhpcy5hY3Rpb25zLmVuZERyYWcoKTtcbiAgfTtcblxuICByZXR1cm4gVGVzdEJhY2tlbmQ7XG59KSgpO1xuXG5mdW5jdGlvbiBjcmVhdGVCYWNrZW5kKG1hbmFnZXIpIHtcbiAgcmV0dXJuIG5ldyBUZXN0QmFja2VuZChtYW5hZ2VyKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmUob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmpbJ2RlZmF1bHQnXSA6IG9iajsgfVxuXG52YXIgX0RyYWdEcm9wTWFuYWdlciA9IHJlcXVpcmUoJy4vRHJhZ0Ryb3BNYW5hZ2VyJyk7XG5cbmV4cG9ydHMuRHJhZ0Ryb3BNYW5hZ2VyID0gX2ludGVyb3BSZXF1aXJlKF9EcmFnRHJvcE1hbmFnZXIpO1xuXG52YXIgX0RyYWdTb3VyY2UgPSByZXF1aXJlKCcuL0RyYWdTb3VyY2UnKTtcblxuZXhwb3J0cy5EcmFnU291cmNlID0gX2ludGVyb3BSZXF1aXJlKF9EcmFnU291cmNlKTtcblxudmFyIF9Ecm9wVGFyZ2V0ID0gcmVxdWlyZSgnLi9Ecm9wVGFyZ2V0Jyk7XG5cbmV4cG9ydHMuRHJvcFRhcmdldCA9IF9pbnRlcm9wUmVxdWlyZShfRHJvcFRhcmdldCk7XG5cbnZhciBfYmFja2VuZHNDcmVhdGVUZXN0QmFja2VuZCA9IHJlcXVpcmUoJy4vYmFja2VuZHMvY3JlYXRlVGVzdEJhY2tlbmQnKTtcblxuZXhwb3J0cy5jcmVhdGVUZXN0QmFja2VuZCA9IF9pbnRlcm9wUmVxdWlyZShfYmFja2VuZHNDcmVhdGVUZXN0QmFja2VuZCk7IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gZGlydHlIYW5kbGVySWRzO1xuZXhwb3J0cy5hcmVEaXJ0eSA9IGFyZURpcnR5O1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfbG9kYXNoWG9yID0gcmVxdWlyZSgnbG9kYXNoL3hvcicpO1xuXG52YXIgX2xvZGFzaFhvcjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hYb3IpO1xuXG52YXIgX2xvZGFzaEludGVyc2VjdGlvbiA9IHJlcXVpcmUoJ2xvZGFzaC9pbnRlcnNlY3Rpb24nKTtcblxudmFyIF9sb2Rhc2hJbnRlcnNlY3Rpb24yID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSW50ZXJzZWN0aW9uKTtcblxudmFyIF9hY3Rpb25zRHJhZ0Ryb3AgPSByZXF1aXJlKCcuLi9hY3Rpb25zL2RyYWdEcm9wJyk7XG5cbnZhciBfYWN0aW9uc1JlZ2lzdHJ5ID0gcmVxdWlyZSgnLi4vYWN0aW9ucy9yZWdpc3RyeScpO1xuXG52YXIgTk9ORSA9IFtdO1xudmFyIEFMTCA9IFtdO1xuXG5mdW5jdGlvbiBkaXJ0eUhhbmRsZXJJZHMoc3RhdGUsIGFjdGlvbiwgZHJhZ09wZXJhdGlvbikge1xuICBpZiAoc3RhdGUgPT09IHVuZGVmaW5lZCkgc3RhdGUgPSBOT05FO1xuXG4gIHN3aXRjaCAoYWN0aW9uLnR5cGUpIHtcbiAgICBjYXNlIF9hY3Rpb25zRHJhZ0Ryb3AuSE9WRVI6XG4gICAgICBicmVhaztcbiAgICBjYXNlIF9hY3Rpb25zUmVnaXN0cnkuQUREX1NPVVJDRTpcbiAgICBjYXNlIF9hY3Rpb25zUmVnaXN0cnkuQUREX1RBUkdFVDpcbiAgICBjYXNlIF9hY3Rpb25zUmVnaXN0cnkuUkVNT1ZFX1RBUkdFVDpcbiAgICBjYXNlIF9hY3Rpb25zUmVnaXN0cnkuUkVNT1ZFX1NPVVJDRTpcbiAgICAgIHJldHVybiBOT05FO1xuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5CRUdJTl9EUkFHOlxuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5QVUJMSVNIX0RSQUdfU09VUkNFOlxuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5FTkRfRFJBRzpcbiAgICBjYXNlIF9hY3Rpb25zRHJhZ0Ryb3AuRFJPUDpcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIEFMTDtcbiAgfVxuXG4gIHZhciB0YXJnZXRJZHMgPSBhY3Rpb24udGFyZ2V0SWRzO1xuICB2YXIgcHJldlRhcmdldElkcyA9IGRyYWdPcGVyYXRpb24udGFyZ2V0SWRzO1xuXG4gIHZhciBkaXJ0eUhhbmRsZXJJZHMgPSBfbG9kYXNoWG9yMlsnZGVmYXVsdCddKHRhcmdldElkcywgcHJldlRhcmdldElkcyk7XG5cbiAgdmFyIGRpZENoYW5nZSA9IGZhbHNlO1xuICBpZiAoZGlydHlIYW5kbGVySWRzLmxlbmd0aCA9PT0gMCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGFyZ2V0SWRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBpZiAodGFyZ2V0SWRzW2ldICE9PSBwcmV2VGFyZ2V0SWRzW2ldKSB7XG4gICAgICAgIGRpZENoYW5nZSA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBkaWRDaGFuZ2UgPSB0cnVlO1xuICB9XG5cbiAgaWYgKCFkaWRDaGFuZ2UpIHtcbiAgICByZXR1cm4gTk9ORTtcbiAgfVxuXG4gIHZhciBwcmV2SW5uZXJtb3N0VGFyZ2V0SWQgPSBwcmV2VGFyZ2V0SWRzW3ByZXZUYXJnZXRJZHMubGVuZ3RoIC0gMV07XG4gIHZhciBpbm5lcm1vc3RUYXJnZXRJZCA9IHRhcmdldElkc1t0YXJnZXRJZHMubGVuZ3RoIC0gMV07XG5cbiAgaWYgKHByZXZJbm5lcm1vc3RUYXJnZXRJZCAhPT0gaW5uZXJtb3N0VGFyZ2V0SWQpIHtcbiAgICBpZiAocHJldklubmVybW9zdFRhcmdldElkKSB7XG4gICAgICBkaXJ0eUhhbmRsZXJJZHMucHVzaChwcmV2SW5uZXJtb3N0VGFyZ2V0SWQpO1xuICAgIH1cbiAgICBpZiAoaW5uZXJtb3N0VGFyZ2V0SWQpIHtcbiAgICAgIGRpcnR5SGFuZGxlcklkcy5wdXNoKGlubmVybW9zdFRhcmdldElkKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZGlydHlIYW5kbGVySWRzO1xufVxuXG5mdW5jdGlvbiBhcmVEaXJ0eShzdGF0ZSwgaGFuZGxlcklkcykge1xuICBpZiAoc3RhdGUgPT09IE5PTkUpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAoc3RhdGUgPT09IEFMTCB8fCB0eXBlb2YgaGFuZGxlcklkcyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiBfbG9kYXNoSW50ZXJzZWN0aW9uMlsnZGVmYXVsdCddKGhhbmRsZXJJZHMsIHN0YXRlKS5sZW5ndGggPiAwO1xufSIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxudmFyIF9leHRlbmRzID0gT2JqZWN0LmFzc2lnbiB8fCBmdW5jdGlvbiAodGFyZ2V0KSB7IGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7IHZhciBzb3VyY2UgPSBhcmd1bWVudHNbaV07IGZvciAodmFyIGtleSBpbiBzb3VyY2UpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzb3VyY2UsIGtleSkpIHsgdGFyZ2V0W2tleV0gPSBzb3VyY2Vba2V5XTsgfSB9IH0gcmV0dXJuIHRhcmdldDsgfTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gZHJhZ09mZnNldDtcbmV4cG9ydHMuZ2V0U291cmNlQ2xpZW50T2Zmc2V0ID0gZ2V0U291cmNlQ2xpZW50T2Zmc2V0O1xuZXhwb3J0cy5nZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQgPSBnZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQ7XG5cbnZhciBfYWN0aW9uc0RyYWdEcm9wID0gcmVxdWlyZSgnLi4vYWN0aW9ucy9kcmFnRHJvcCcpO1xuXG52YXIgaW5pdGlhbFN0YXRlID0ge1xuICBpbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0OiBudWxsLFxuICBpbml0aWFsQ2xpZW50T2Zmc2V0OiBudWxsLFxuICBjbGllbnRPZmZzZXQ6IG51bGxcbn07XG5cbmZ1bmN0aW9uIGFyZU9mZnNldHNFcXVhbChvZmZzZXRBLCBvZmZzZXRCKSB7XG4gIGlmIChvZmZzZXRBID09PSBvZmZzZXRCKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIG9mZnNldEEgJiYgb2Zmc2V0QiAmJiBvZmZzZXRBLnggPT09IG9mZnNldEIueCAmJiBvZmZzZXRBLnkgPT09IG9mZnNldEIueTtcbn1cblxuZnVuY3Rpb24gZHJhZ09mZnNldChzdGF0ZSwgYWN0aW9uKSB7XG4gIGlmIChzdGF0ZSA9PT0gdW5kZWZpbmVkKSBzdGF0ZSA9IGluaXRpYWxTdGF0ZTtcblxuICBzd2l0Y2ggKGFjdGlvbi50eXBlKSB7XG4gICAgY2FzZSBfYWN0aW9uc0RyYWdEcm9wLkJFR0lOX0RSQUc6XG4gICAgICByZXR1cm4ge1xuICAgICAgICBpbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0OiBhY3Rpb24uc291cmNlQ2xpZW50T2Zmc2V0LFxuICAgICAgICBpbml0aWFsQ2xpZW50T2Zmc2V0OiBhY3Rpb24uY2xpZW50T2Zmc2V0LFxuICAgICAgICBjbGllbnRPZmZzZXQ6IGFjdGlvbi5jbGllbnRPZmZzZXRcbiAgICAgIH07XG4gICAgY2FzZSBfYWN0aW9uc0RyYWdEcm9wLkhPVkVSOlxuICAgICAgaWYgKGFyZU9mZnNldHNFcXVhbChzdGF0ZS5jbGllbnRPZmZzZXQsIGFjdGlvbi5jbGllbnRPZmZzZXQpKSB7XG4gICAgICAgIHJldHVybiBzdGF0ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBfZXh0ZW5kcyh7fSwgc3RhdGUsIHtcbiAgICAgICAgY2xpZW50T2Zmc2V0OiBhY3Rpb24uY2xpZW50T2Zmc2V0XG4gICAgICB9KTtcbiAgICBjYXNlIF9hY3Rpb25zRHJhZ0Ryb3AuRU5EX0RSQUc6XG4gICAgY2FzZSBfYWN0aW9uc0RyYWdEcm9wLkRST1A6XG4gICAgICByZXR1cm4gaW5pdGlhbFN0YXRlO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gc3RhdGU7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0U291cmNlQ2xpZW50T2Zmc2V0KHN0YXRlKSB7XG4gIHZhciBjbGllbnRPZmZzZXQgPSBzdGF0ZS5jbGllbnRPZmZzZXQ7XG4gIHZhciBpbml0aWFsQ2xpZW50T2Zmc2V0ID0gc3RhdGUuaW5pdGlhbENsaWVudE9mZnNldDtcbiAgdmFyIGluaXRpYWxTb3VyY2VDbGllbnRPZmZzZXQgPSBzdGF0ZS5pbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0O1xuXG4gIGlmICghY2xpZW50T2Zmc2V0IHx8ICFpbml0aWFsQ2xpZW50T2Zmc2V0IHx8ICFpbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0KSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB4OiBjbGllbnRPZmZzZXQueCArIGluaXRpYWxTb3VyY2VDbGllbnRPZmZzZXQueCAtIGluaXRpYWxDbGllbnRPZmZzZXQueCxcbiAgICB5OiBjbGllbnRPZmZzZXQueSArIGluaXRpYWxTb3VyY2VDbGllbnRPZmZzZXQueSAtIGluaXRpYWxDbGllbnRPZmZzZXQueVxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQoc3RhdGUpIHtcbiAgdmFyIGNsaWVudE9mZnNldCA9IHN0YXRlLmNsaWVudE9mZnNldDtcbiAgdmFyIGluaXRpYWxDbGllbnRPZmZzZXQgPSBzdGF0ZS5pbml0aWFsQ2xpZW50T2Zmc2V0O1xuXG4gIGlmICghY2xpZW50T2Zmc2V0IHx8ICFpbml0aWFsQ2xpZW50T2Zmc2V0KSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB4OiBjbGllbnRPZmZzZXQueCAtIGluaXRpYWxDbGllbnRPZmZzZXQueCxcbiAgICB5OiBjbGllbnRPZmZzZXQueSAtIGluaXRpYWxDbGllbnRPZmZzZXQueVxuICB9O1xufSIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxudmFyIF9leHRlbmRzID0gT2JqZWN0LmFzc2lnbiB8fCBmdW5jdGlvbiAodGFyZ2V0KSB7IGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7IHZhciBzb3VyY2UgPSBhcmd1bWVudHNbaV07IGZvciAodmFyIGtleSBpbiBzb3VyY2UpIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzb3VyY2UsIGtleSkpIHsgdGFyZ2V0W2tleV0gPSBzb3VyY2Vba2V5XTsgfSB9IH0gcmV0dXJuIHRhcmdldDsgfTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gZHJhZ09wZXJhdGlvbjtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG52YXIgX2FjdGlvbnNEcmFnRHJvcCA9IHJlcXVpcmUoJy4uL2FjdGlvbnMvZHJhZ0Ryb3AnKTtcblxudmFyIF9hY3Rpb25zUmVnaXN0cnkgPSByZXF1aXJlKCcuLi9hY3Rpb25zL3JlZ2lzdHJ5Jyk7XG5cbnZhciBfbG9kYXNoV2l0aG91dCA9IHJlcXVpcmUoJ2xvZGFzaC93aXRob3V0Jyk7XG5cbnZhciBfbG9kYXNoV2l0aG91dDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hXaXRob3V0KTtcblxudmFyIGluaXRpYWxTdGF0ZSA9IHtcbiAgaXRlbVR5cGU6IG51bGwsXG4gIGl0ZW06IG51bGwsXG4gIHNvdXJjZUlkOiBudWxsLFxuICB0YXJnZXRJZHM6IFtdLFxuICBkcm9wUmVzdWx0OiBudWxsLFxuICBkaWREcm9wOiBmYWxzZSxcbiAgaXNTb3VyY2VQdWJsaWM6IG51bGxcbn07XG5cbmZ1bmN0aW9uIGRyYWdPcGVyYXRpb24oc3RhdGUsIGFjdGlvbikge1xuICBpZiAoc3RhdGUgPT09IHVuZGVmaW5lZCkgc3RhdGUgPSBpbml0aWFsU3RhdGU7XG5cbiAgc3dpdGNoIChhY3Rpb24udHlwZSkge1xuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5CRUdJTl9EUkFHOlxuICAgICAgcmV0dXJuIF9leHRlbmRzKHt9LCBzdGF0ZSwge1xuICAgICAgICBpdGVtVHlwZTogYWN0aW9uLml0ZW1UeXBlLFxuICAgICAgICBpdGVtOiBhY3Rpb24uaXRlbSxcbiAgICAgICAgc291cmNlSWQ6IGFjdGlvbi5zb3VyY2VJZCxcbiAgICAgICAgaXNTb3VyY2VQdWJsaWM6IGFjdGlvbi5pc1NvdXJjZVB1YmxpYyxcbiAgICAgICAgZHJvcFJlc3VsdDogbnVsbCxcbiAgICAgICAgZGlkRHJvcDogZmFsc2VcbiAgICAgIH0pO1xuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5QVUJMSVNIX0RSQUdfU09VUkNFOlxuICAgICAgcmV0dXJuIF9leHRlbmRzKHt9LCBzdGF0ZSwge1xuICAgICAgICBpc1NvdXJjZVB1YmxpYzogdHJ1ZVxuICAgICAgfSk7XG4gICAgY2FzZSBfYWN0aW9uc0RyYWdEcm9wLkhPVkVSOlxuICAgICAgcmV0dXJuIF9leHRlbmRzKHt9LCBzdGF0ZSwge1xuICAgICAgICB0YXJnZXRJZHM6IGFjdGlvbi50YXJnZXRJZHNcbiAgICAgIH0pO1xuICAgIGNhc2UgX2FjdGlvbnNSZWdpc3RyeS5SRU1PVkVfVEFSR0VUOlxuICAgICAgaWYgKHN0YXRlLnRhcmdldElkcy5pbmRleE9mKGFjdGlvbi50YXJnZXRJZCkgPT09IC0xKSB7XG4gICAgICAgIHJldHVybiBzdGF0ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBfZXh0ZW5kcyh7fSwgc3RhdGUsIHtcbiAgICAgICAgdGFyZ2V0SWRzOiBfbG9kYXNoV2l0aG91dDJbJ2RlZmF1bHQnXShzdGF0ZS50YXJnZXRJZHMsIGFjdGlvbi50YXJnZXRJZClcbiAgICAgIH0pO1xuICAgIGNhc2UgX2FjdGlvbnNEcmFnRHJvcC5EUk9QOlxuICAgICAgcmV0dXJuIF9leHRlbmRzKHt9LCBzdGF0ZSwge1xuICAgICAgICBkcm9wUmVzdWx0OiBhY3Rpb24uZHJvcFJlc3VsdCxcbiAgICAgICAgZGlkRHJvcDogdHJ1ZSxcbiAgICAgICAgdGFyZ2V0SWRzOiBbXVxuICAgICAgfSk7XG4gICAgY2FzZSBfYWN0aW9uc0RyYWdEcm9wLkVORF9EUkFHOlxuICAgICAgcmV0dXJuIF9leHRlbmRzKHt9LCBzdGF0ZSwge1xuICAgICAgICBpdGVtVHlwZTogbnVsbCxcbiAgICAgICAgaXRlbTogbnVsbCxcbiAgICAgICAgc291cmNlSWQ6IG51bGwsXG4gICAgICAgIGRyb3BSZXN1bHQ6IG51bGwsXG4gICAgICAgIGRpZERyb3A6IGZhbHNlLFxuICAgICAgICBpc1NvdXJjZVB1YmxpYzogbnVsbCxcbiAgICAgICAgdGFyZ2V0SWRzOiBbXVxuICAgICAgfSk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBzdGF0ZTtcbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxudmFyIF9kcmFnT2Zmc2V0ID0gcmVxdWlyZSgnLi9kcmFnT2Zmc2V0Jyk7XG5cbnZhciBfZHJhZ09mZnNldDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9kcmFnT2Zmc2V0KTtcblxudmFyIF9kcmFnT3BlcmF0aW9uID0gcmVxdWlyZSgnLi9kcmFnT3BlcmF0aW9uJyk7XG5cbnZhciBfZHJhZ09wZXJhdGlvbjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9kcmFnT3BlcmF0aW9uKTtcblxudmFyIF9yZWZDb3VudCA9IHJlcXVpcmUoJy4vcmVmQ291bnQnKTtcblxudmFyIF9yZWZDb3VudDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9yZWZDb3VudCk7XG5cbnZhciBfZGlydHlIYW5kbGVySWRzID0gcmVxdWlyZSgnLi9kaXJ0eUhhbmRsZXJJZHMnKTtcblxudmFyIF9kaXJ0eUhhbmRsZXJJZHMyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfZGlydHlIYW5kbGVySWRzKTtcblxudmFyIF9zdGF0ZUlkID0gcmVxdWlyZSgnLi9zdGF0ZUlkJyk7XG5cbnZhciBfc3RhdGVJZDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9zdGF0ZUlkKTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gZnVuY3Rpb24gKHN0YXRlLCBhY3Rpb24pIHtcbiAgaWYgKHN0YXRlID09PSB1bmRlZmluZWQpIHN0YXRlID0ge307XG5cbiAgcmV0dXJuIHtcbiAgICBkaXJ0eUhhbmRsZXJJZHM6IF9kaXJ0eUhhbmRsZXJJZHMyWydkZWZhdWx0J10oc3RhdGUuZGlydHlIYW5kbGVySWRzLCBhY3Rpb24sIHN0YXRlLmRyYWdPcGVyYXRpb24pLFxuICAgIGRyYWdPZmZzZXQ6IF9kcmFnT2Zmc2V0MlsnZGVmYXVsdCddKHN0YXRlLmRyYWdPZmZzZXQsIGFjdGlvbiksXG4gICAgcmVmQ291bnQ6IF9yZWZDb3VudDJbJ2RlZmF1bHQnXShzdGF0ZS5yZWZDb3VudCwgYWN0aW9uKSxcbiAgICBkcmFnT3BlcmF0aW9uOiBfZHJhZ09wZXJhdGlvbjJbJ2RlZmF1bHQnXShzdGF0ZS5kcmFnT3BlcmF0aW9uLCBhY3Rpb24pLFxuICAgIHN0YXRlSWQ6IF9zdGF0ZUlkMlsnZGVmYXVsdCddKHN0YXRlLnN0YXRlSWQpXG4gIH07XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSByZWZDb3VudDtcblxudmFyIF9hY3Rpb25zUmVnaXN0cnkgPSByZXF1aXJlKCcuLi9hY3Rpb25zL3JlZ2lzdHJ5Jyk7XG5cbmZ1bmN0aW9uIHJlZkNvdW50KHN0YXRlLCBhY3Rpb24pIHtcbiAgaWYgKHN0YXRlID09PSB1bmRlZmluZWQpIHN0YXRlID0gMDtcblxuICBzd2l0Y2ggKGFjdGlvbi50eXBlKSB7XG4gICAgY2FzZSBfYWN0aW9uc1JlZ2lzdHJ5LkFERF9TT1VSQ0U6XG4gICAgY2FzZSBfYWN0aW9uc1JlZ2lzdHJ5LkFERF9UQVJHRVQ6XG4gICAgICByZXR1cm4gc3RhdGUgKyAxO1xuICAgIGNhc2UgX2FjdGlvbnNSZWdpc3RyeS5SRU1PVkVfU09VUkNFOlxuICAgIGNhc2UgX2FjdGlvbnNSZWdpc3RyeS5SRU1PVkVfVEFSR0VUOlxuICAgICAgcmV0dXJuIHN0YXRlIC0gMTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHN0YXRlO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIlwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1tcImRlZmF1bHRcIl0gPSBzdGF0ZUlkO1xuXG5mdW5jdGlvbiBzdGF0ZUlkKCkge1xuICB2YXIgc3RhdGUgPSBhcmd1bWVudHMubGVuZ3RoIDw9IDAgfHwgYXJndW1lbnRzWzBdID09PSB1bmRlZmluZWQgPyAwIDogYXJndW1lbnRzWzBdO1xuXG4gIHJldHVybiBzdGF0ZSArIDE7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1tcImRlZmF1bHRcIl07IiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IGdldE5leHRVbmlxdWVJZDtcbnZhciBuZXh0VW5pcXVlSWQgPSAwO1xuXG5mdW5jdGlvbiBnZXROZXh0VW5pcXVlSWQoKSB7XG4gIHJldHVybiBuZXh0VW5pcXVlSWQrKztcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzW1wiZGVmYXVsdFwiXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBtYXRjaGVzVHlwZTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG52YXIgX2xvZGFzaElzQXJyYXkgPSByZXF1aXJlKCdsb2Rhc2gvaXNBcnJheScpO1xuXG52YXIgX2xvZGFzaElzQXJyYXkyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNBcnJheSk7XG5cbmZ1bmN0aW9uIG1hdGNoZXNUeXBlKHRhcmdldFR5cGUsIGRyYWdnZWRJdGVtVHlwZSkge1xuICBpZiAoX2xvZGFzaElzQXJyYXkyWydkZWZhdWx0J10odGFyZ2V0VHlwZSkpIHtcbiAgICByZXR1cm4gdGFyZ2V0VHlwZS5zb21lKGZ1bmN0aW9uICh0KSB7XG4gICAgICByZXR1cm4gdCA9PT0gZHJhZ2dlZEl0ZW1UeXBlO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiB0YXJnZXRUeXBlID09PSBkcmFnZ2VkSXRlbVR5cGU7XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwidmFyIG5hdGl2ZUNyZWF0ZSA9IHJlcXVpcmUoJy4vX25hdGl2ZUNyZWF0ZScpO1xuXG4vKiogVXNlZCBmb3IgYnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMuICovXG52YXIgb2JqZWN0UHJvdG8gPSBPYmplY3QucHJvdG90eXBlO1xuXG4vKipcbiAqIENyZWF0ZXMgYSBoYXNoIG9iamVjdC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQGNvbnN0cnVjdG9yXG4gKiBAcmV0dXJucyB7T2JqZWN0fSBSZXR1cm5zIHRoZSBuZXcgaGFzaCBvYmplY3QuXG4gKi9cbmZ1bmN0aW9uIEhhc2goKSB7fVxuXG4vLyBBdm9pZCBpbmhlcml0aW5nIGZyb20gYE9iamVjdC5wcm90b3R5cGVgIHdoZW4gcG9zc2libGUuXG5IYXNoLnByb3RvdHlwZSA9IG5hdGl2ZUNyZWF0ZSA/IG5hdGl2ZUNyZWF0ZShudWxsKSA6IG9iamVjdFByb3RvO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEhhc2g7XG4iLCJ2YXIgZ2V0TmF0aXZlID0gcmVxdWlyZSgnLi9fZ2V0TmF0aXZlJyksXG4gICAgcm9vdCA9IHJlcXVpcmUoJy4vX3Jvb3QnKTtcblxuLyogQnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMgdGhhdCBhcmUgdmVyaWZpZWQgdG8gYmUgbmF0aXZlLiAqL1xudmFyIE1hcCA9IGdldE5hdGl2ZShyb290LCAnTWFwJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gTWFwO1xuIiwidmFyIG1hcENsZWFyID0gcmVxdWlyZSgnLi9fbWFwQ2xlYXInKSxcbiAgICBtYXBEZWxldGUgPSByZXF1aXJlKCcuL19tYXBEZWxldGUnKSxcbiAgICBtYXBHZXQgPSByZXF1aXJlKCcuL19tYXBHZXQnKSxcbiAgICBtYXBIYXMgPSByZXF1aXJlKCcuL19tYXBIYXMnKSxcbiAgICBtYXBTZXQgPSByZXF1aXJlKCcuL19tYXBTZXQnKTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgbWFwIGNhY2hlIG9iamVjdCB0byBzdG9yZSBrZXktdmFsdWUgcGFpcnMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBjb25zdHJ1Y3RvclxuICogQHBhcmFtIHtBcnJheX0gW3ZhbHVlc10gVGhlIHZhbHVlcyB0byBjYWNoZS5cbiAqL1xuZnVuY3Rpb24gTWFwQ2FjaGUodmFsdWVzKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgbGVuZ3RoID0gdmFsdWVzID8gdmFsdWVzLmxlbmd0aCA6IDA7XG5cbiAgdGhpcy5jbGVhcigpO1xuICB3aGlsZSAoKytpbmRleCA8IGxlbmd0aCkge1xuICAgIHZhciBlbnRyeSA9IHZhbHVlc1tpbmRleF07XG4gICAgdGhpcy5zZXQoZW50cnlbMF0sIGVudHJ5WzFdKTtcbiAgfVxufVxuXG4vLyBBZGQgbWV0aG9kcyB0byBgTWFwQ2FjaGVgLlxuTWFwQ2FjaGUucHJvdG90eXBlLmNsZWFyID0gbWFwQ2xlYXI7XG5NYXBDYWNoZS5wcm90b3R5cGVbJ2RlbGV0ZSddID0gbWFwRGVsZXRlO1xuTWFwQ2FjaGUucHJvdG90eXBlLmdldCA9IG1hcEdldDtcbk1hcENhY2hlLnByb3RvdHlwZS5oYXMgPSBtYXBIYXM7XG5NYXBDYWNoZS5wcm90b3R5cGUuc2V0ID0gbWFwU2V0O1xuXG5tb2R1bGUuZXhwb3J0cyA9IE1hcENhY2hlO1xuIiwidmFyIGdldE5hdGl2ZSA9IHJlcXVpcmUoJy4vX2dldE5hdGl2ZScpLFxuICAgIHJvb3QgPSByZXF1aXJlKCcuL19yb290Jyk7XG5cbi8qIEJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzIHRoYXQgYXJlIHZlcmlmaWVkIHRvIGJlIG5hdGl2ZS4gKi9cbnZhciBTZXQgPSBnZXROYXRpdmUocm9vdCwgJ1NldCcpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFNldDtcbiIsInZhciBNYXBDYWNoZSA9IHJlcXVpcmUoJy4vX01hcENhY2hlJyksXG4gICAgY2FjaGVQdXNoID0gcmVxdWlyZSgnLi9fY2FjaGVQdXNoJyk7XG5cbi8qKlxuICpcbiAqIENyZWF0ZXMgYSBzZXQgY2FjaGUgb2JqZWN0IHRvIHN0b3JlIHVuaXF1ZSB2YWx1ZXMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBjb25zdHJ1Y3RvclxuICogQHBhcmFtIHtBcnJheX0gW3ZhbHVlc10gVGhlIHZhbHVlcyB0byBjYWNoZS5cbiAqL1xuZnVuY3Rpb24gU2V0Q2FjaGUodmFsdWVzKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgbGVuZ3RoID0gdmFsdWVzID8gdmFsdWVzLmxlbmd0aCA6IDA7XG5cbiAgdGhpcy5fX2RhdGFfXyA9IG5ldyBNYXBDYWNoZTtcbiAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGgpIHtcbiAgICB0aGlzLnB1c2godmFsdWVzW2luZGV4XSk7XG4gIH1cbn1cblxuLy8gQWRkIG1ldGhvZHMgdG8gYFNldENhY2hlYC5cblNldENhY2hlLnByb3RvdHlwZS5wdXNoID0gY2FjaGVQdXNoO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFNldENhY2hlO1xuIiwiLyoqXG4gKiBBIGZhc3RlciBhbHRlcm5hdGl2ZSB0byBgRnVuY3Rpb24jYXBwbHlgLCB0aGlzIGZ1bmN0aW9uIGludm9rZXMgYGZ1bmNgXG4gKiB3aXRoIHRoZSBgdGhpc2AgYmluZGluZyBvZiBgdGhpc0FyZ2AgYW5kIHRoZSBhcmd1bWVudHMgb2YgYGFyZ3NgLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBmdW5jdGlvbiB0byBpbnZva2UuXG4gKiBAcGFyYW0geyp9IHRoaXNBcmcgVGhlIGB0aGlzYCBiaW5kaW5nIG9mIGBmdW5jYC5cbiAqIEBwYXJhbSB7QXJyYXl9IGFyZ3MgVGhlIGFyZ3VtZW50cyB0byBpbnZva2UgYGZ1bmNgIHdpdGguXG4gKiBAcmV0dXJucyB7Kn0gUmV0dXJucyB0aGUgcmVzdWx0IG9mIGBmdW5jYC5cbiAqL1xuZnVuY3Rpb24gYXBwbHkoZnVuYywgdGhpc0FyZywgYXJncykge1xuICB2YXIgbGVuZ3RoID0gYXJncy5sZW5ndGg7XG4gIHN3aXRjaCAobGVuZ3RoKSB7XG4gICAgY2FzZSAwOiByZXR1cm4gZnVuYy5jYWxsKHRoaXNBcmcpO1xuICAgIGNhc2UgMTogcmV0dXJuIGZ1bmMuY2FsbCh0aGlzQXJnLCBhcmdzWzBdKTtcbiAgICBjYXNlIDI6IHJldHVybiBmdW5jLmNhbGwodGhpc0FyZywgYXJnc1swXSwgYXJnc1sxXSk7XG4gICAgY2FzZSAzOiByZXR1cm4gZnVuYy5jYWxsKHRoaXNBcmcsIGFyZ3NbMF0sIGFyZ3NbMV0sIGFyZ3NbMl0pO1xuICB9XG4gIHJldHVybiBmdW5jLmFwcGx5KHRoaXNBcmcsIGFyZ3MpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGFwcGx5O1xuIiwiLyoqXG4gKiBBIHNwZWNpYWxpemVkIHZlcnNpb24gb2YgYF8uZmlsdGVyYCBmb3IgYXJyYXlzIHdpdGhvdXQgc3VwcG9ydCBmb3JcbiAqIGl0ZXJhdGVlIHNob3J0aGFuZHMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBpdGVyYXRlIG92ZXIuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBwcmVkaWNhdGUgVGhlIGZ1bmN0aW9uIGludm9rZWQgcGVyIGl0ZXJhdGlvbi5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgbmV3IGZpbHRlcmVkIGFycmF5LlxuICovXG5mdW5jdGlvbiBhcnJheUZpbHRlcihhcnJheSwgcHJlZGljYXRlKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgbGVuZ3RoID0gYXJyYXkubGVuZ3RoLFxuICAgICAgcmVzSW5kZXggPSAwLFxuICAgICAgcmVzdWx0ID0gW107XG5cbiAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGgpIHtcbiAgICB2YXIgdmFsdWUgPSBhcnJheVtpbmRleF07XG4gICAgaWYgKHByZWRpY2F0ZSh2YWx1ZSwgaW5kZXgsIGFycmF5KSkge1xuICAgICAgcmVzdWx0W3Jlc0luZGV4KytdID0gdmFsdWU7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXJyYXlGaWx0ZXI7XG4iLCJ2YXIgYmFzZUluZGV4T2YgPSByZXF1aXJlKCcuL19iYXNlSW5kZXhPZicpO1xuXG4vKipcbiAqIEEgc3BlY2lhbGl6ZWQgdmVyc2lvbiBvZiBgXy5pbmNsdWRlc2AgZm9yIGFycmF5cyB3aXRob3V0IHN1cHBvcnQgZm9yXG4gKiBzcGVjaWZ5aW5nIGFuIGluZGV4IHRvIHNlYXJjaCBmcm9tLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0FycmF5fSBhcnJheSBUaGUgYXJyYXkgdG8gc2VhcmNoLlxuICogQHBhcmFtIHsqfSB0YXJnZXQgVGhlIHZhbHVlIHRvIHNlYXJjaCBmb3IuXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHRhcmdldGAgaXMgZm91bmQsIGVsc2UgYGZhbHNlYC5cbiAqL1xuZnVuY3Rpb24gYXJyYXlJbmNsdWRlcyhhcnJheSwgdmFsdWUpIHtcbiAgcmV0dXJuICEhYXJyYXkubGVuZ3RoICYmIGJhc2VJbmRleE9mKGFycmF5LCB2YWx1ZSwgMCkgPiAtMTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBhcnJheUluY2x1ZGVzO1xuIiwiLyoqXG4gKiBUaGlzIGZ1bmN0aW9uIGlzIGxpa2UgYGFycmF5SW5jbHVkZXNgIGV4Y2VwdCB0aGF0IGl0IGFjY2VwdHMgYSBjb21wYXJhdG9yLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0FycmF5fSBhcnJheSBUaGUgYXJyYXkgdG8gc2VhcmNoLlxuICogQHBhcmFtIHsqfSB0YXJnZXQgVGhlIHZhbHVlIHRvIHNlYXJjaCBmb3IuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBjb21wYXJhdG9yIFRoZSBjb21wYXJhdG9yIGludm9rZWQgcGVyIGVsZW1lbnQuXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHRhcmdldGAgaXMgZm91bmQsIGVsc2UgYGZhbHNlYC5cbiAqL1xuZnVuY3Rpb24gYXJyYXlJbmNsdWRlc1dpdGgoYXJyYXksIHZhbHVlLCBjb21wYXJhdG9yKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgbGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xuXG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgaWYgKGNvbXBhcmF0b3IodmFsdWUsIGFycmF5W2luZGV4XSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXJyYXlJbmNsdWRlc1dpdGg7XG4iLCIvKipcbiAqIEEgc3BlY2lhbGl6ZWQgdmVyc2lvbiBvZiBgXy5tYXBgIGZvciBhcnJheXMgd2l0aG91dCBzdXBwb3J0IGZvciBpdGVyYXRlZVxuICogc2hvcnRoYW5kcy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIGl0ZXJhdGUgb3Zlci5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IGl0ZXJhdGVlIFRoZSBmdW5jdGlvbiBpbnZva2VkIHBlciBpdGVyYXRpb24uXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIG5ldyBtYXBwZWQgYXJyYXkuXG4gKi9cbmZ1bmN0aW9uIGFycmF5TWFwKGFycmF5LCBpdGVyYXRlZSkge1xuICB2YXIgaW5kZXggPSAtMSxcbiAgICAgIGxlbmd0aCA9IGFycmF5Lmxlbmd0aCxcbiAgICAgIHJlc3VsdCA9IEFycmF5KGxlbmd0aCk7XG5cbiAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGgpIHtcbiAgICByZXN1bHRbaW5kZXhdID0gaXRlcmF0ZWUoYXJyYXlbaW5kZXhdLCBpbmRleCwgYXJyYXkpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXJyYXlNYXA7XG4iLCIvKipcbiAqIEFwcGVuZHMgdGhlIGVsZW1lbnRzIG9mIGB2YWx1ZXNgIHRvIGBhcnJheWAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBtb2RpZnkuXG4gKiBAcGFyYW0ge0FycmF5fSB2YWx1ZXMgVGhlIHZhbHVlcyB0byBhcHBlbmQuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgYGFycmF5YC5cbiAqL1xuZnVuY3Rpb24gYXJyYXlQdXNoKGFycmF5LCB2YWx1ZXMpIHtcbiAgdmFyIGluZGV4ID0gLTEsXG4gICAgICBsZW5ndGggPSB2YWx1ZXMubGVuZ3RoLFxuICAgICAgb2Zmc2V0ID0gYXJyYXkubGVuZ3RoO1xuXG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgYXJyYXlbb2Zmc2V0ICsgaW5kZXhdID0gdmFsdWVzW2luZGV4XTtcbiAgfVxuICByZXR1cm4gYXJyYXk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXJyYXlQdXNoO1xuIiwidmFyIGFzc29jSW5kZXhPZiA9IHJlcXVpcmUoJy4vX2Fzc29jSW5kZXhPZicpO1xuXG4vKiogVXNlZCBmb3IgYnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMuICovXG52YXIgYXJyYXlQcm90byA9IEFycmF5LnByb3RvdHlwZTtcblxuLyoqIEJ1aWx0LWluIHZhbHVlIHJlZmVyZW5jZXMuICovXG52YXIgc3BsaWNlID0gYXJyYXlQcm90by5zcGxpY2U7XG5cbi8qKlxuICogUmVtb3ZlcyBga2V5YCBhbmQgaXRzIHZhbHVlIGZyb20gdGhlIGFzc29jaWF0aXZlIGFycmF5LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0FycmF5fSBhcnJheSBUaGUgYXJyYXkgdG8gbW9kaWZ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSB2YWx1ZSB0byByZW1vdmUuXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgdGhlIGVudHJ5IHdhcyByZW1vdmVkLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGFzc29jRGVsZXRlKGFycmF5LCBrZXkpIHtcbiAgdmFyIGluZGV4ID0gYXNzb2NJbmRleE9mKGFycmF5LCBrZXkpO1xuICBpZiAoaW5kZXggPCAwKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHZhciBsYXN0SW5kZXggPSBhcnJheS5sZW5ndGggLSAxO1xuICBpZiAoaW5kZXggPT0gbGFzdEluZGV4KSB7XG4gICAgYXJyYXkucG9wKCk7XG4gIH0gZWxzZSB7XG4gICAgc3BsaWNlLmNhbGwoYXJyYXksIGluZGV4LCAxKTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBhc3NvY0RlbGV0ZTtcbiIsInZhciBhc3NvY0luZGV4T2YgPSByZXF1aXJlKCcuL19hc3NvY0luZGV4T2YnKTtcblxuLyoqXG4gKiBHZXRzIHRoZSBhc3NvY2lhdGl2ZSBhcnJheSB2YWx1ZSBmb3IgYGtleWAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBxdWVyeS5cbiAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgVGhlIGtleSBvZiB0aGUgdmFsdWUgdG8gZ2V0LlxuICogQHJldHVybnMgeyp9IFJldHVybnMgdGhlIGVudHJ5IHZhbHVlLlxuICovXG5mdW5jdGlvbiBhc3NvY0dldChhcnJheSwga2V5KSB7XG4gIHZhciBpbmRleCA9IGFzc29jSW5kZXhPZihhcnJheSwga2V5KTtcbiAgcmV0dXJuIGluZGV4IDwgMCA/IHVuZGVmaW5lZCA6IGFycmF5W2luZGV4XVsxXTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBhc3NvY0dldDtcbiIsInZhciBhc3NvY0luZGV4T2YgPSByZXF1aXJlKCcuL19hc3NvY0luZGV4T2YnKTtcblxuLyoqXG4gKiBDaGVja3MgaWYgYW4gYXNzb2NpYXRpdmUgYXJyYXkgdmFsdWUgZm9yIGBrZXlgIGV4aXN0cy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIHF1ZXJ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSBlbnRyeSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBhbiBlbnRyeSBmb3IgYGtleWAgZXhpc3RzLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGFzc29jSGFzKGFycmF5LCBrZXkpIHtcbiAgcmV0dXJuIGFzc29jSW5kZXhPZihhcnJheSwga2V5KSA+IC0xO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGFzc29jSGFzO1xuIiwidmFyIGVxID0gcmVxdWlyZSgnLi9lcScpO1xuXG4vKipcbiAqIEdldHMgdGhlIGluZGV4IGF0IHdoaWNoIHRoZSBga2V5YCBpcyBmb3VuZCBpbiBgYXJyYXlgIG9mIGtleS12YWx1ZSBwYWlycy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIHNlYXJjaC5cbiAqIEBwYXJhbSB7Kn0ga2V5IFRoZSBrZXkgdG8gc2VhcmNoIGZvci5cbiAqIEByZXR1cm5zIHtudW1iZXJ9IFJldHVybnMgdGhlIGluZGV4IG9mIHRoZSBtYXRjaGVkIHZhbHVlLCBlbHNlIGAtMWAuXG4gKi9cbmZ1bmN0aW9uIGFzc29jSW5kZXhPZihhcnJheSwga2V5KSB7XG4gIHZhciBsZW5ndGggPSBhcnJheS5sZW5ndGg7XG4gIHdoaWxlIChsZW5ndGgtLSkge1xuICAgIGlmIChlcShhcnJheVtsZW5ndGhdWzBdLCBrZXkpKSB7XG4gICAgICByZXR1cm4gbGVuZ3RoO1xuICAgIH1cbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXNzb2NJbmRleE9mO1xuIiwidmFyIGFzc29jSW5kZXhPZiA9IHJlcXVpcmUoJy4vX2Fzc29jSW5kZXhPZicpO1xuXG4vKipcbiAqIFNldHMgdGhlIGFzc29jaWF0aXZlIGFycmF5IGBrZXlgIHRvIGB2YWx1ZWAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBtb2RpZnkuXG4gKiBAcGFyYW0ge3N0cmluZ30ga2V5IFRoZSBrZXkgb2YgdGhlIHZhbHVlIHRvIHNldC5cbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIHNldC5cbiAqL1xuZnVuY3Rpb24gYXNzb2NTZXQoYXJyYXksIGtleSwgdmFsdWUpIHtcbiAgdmFyIGluZGV4ID0gYXNzb2NJbmRleE9mKGFycmF5LCBrZXkpO1xuICBpZiAoaW5kZXggPCAwKSB7XG4gICAgYXJyYXkucHVzaChba2V5LCB2YWx1ZV0pO1xuICB9IGVsc2Uge1xuICAgIGFycmF5W2luZGV4XVsxXSA9IHZhbHVlO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXNzb2NTZXQ7XG4iLCJ2YXIgU2V0Q2FjaGUgPSByZXF1aXJlKCcuL19TZXRDYWNoZScpLFxuICAgIGFycmF5SW5jbHVkZXMgPSByZXF1aXJlKCcuL19hcnJheUluY2x1ZGVzJyksXG4gICAgYXJyYXlJbmNsdWRlc1dpdGggPSByZXF1aXJlKCcuL19hcnJheUluY2x1ZGVzV2l0aCcpLFxuICAgIGFycmF5TWFwID0gcmVxdWlyZSgnLi9fYXJyYXlNYXAnKSxcbiAgICBiYXNlVW5hcnkgPSByZXF1aXJlKCcuL19iYXNlVW5hcnknKSxcbiAgICBjYWNoZUhhcyA9IHJlcXVpcmUoJy4vX2NhY2hlSGFzJyk7XG5cbi8qKiBVc2VkIGFzIHRoZSBzaXplIHRvIGVuYWJsZSBsYXJnZSBhcnJheSBvcHRpbWl6YXRpb25zLiAqL1xudmFyIExBUkdFX0FSUkFZX1NJWkUgPSAyMDA7XG5cbi8qKlxuICogVGhlIGJhc2UgaW1wbGVtZW50YXRpb24gb2YgbWV0aG9kcyBsaWtlIGBfLmRpZmZlcmVuY2VgIHdpdGhvdXQgc3VwcG9ydFxuICogZm9yIGV4Y2x1ZGluZyBtdWx0aXBsZSBhcnJheXMgb3IgaXRlcmF0ZWUgc2hvcnRoYW5kcy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIGluc3BlY3QuXG4gKiBAcGFyYW0ge0FycmF5fSB2YWx1ZXMgVGhlIHZhbHVlcyB0byBleGNsdWRlLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gW2l0ZXJhdGVlXSBUaGUgaXRlcmF0ZWUgaW52b2tlZCBwZXIgZWxlbWVudC5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IFtjb21wYXJhdG9yXSBUaGUgY29tcGFyYXRvciBpbnZva2VkIHBlciBlbGVtZW50LlxuICogQHJldHVybnMge0FycmF5fSBSZXR1cm5zIHRoZSBuZXcgYXJyYXkgb2YgZmlsdGVyZWQgdmFsdWVzLlxuICovXG5mdW5jdGlvbiBiYXNlRGlmZmVyZW5jZShhcnJheSwgdmFsdWVzLCBpdGVyYXRlZSwgY29tcGFyYXRvcikge1xuICB2YXIgaW5kZXggPSAtMSxcbiAgICAgIGluY2x1ZGVzID0gYXJyYXlJbmNsdWRlcyxcbiAgICAgIGlzQ29tbW9uID0gdHJ1ZSxcbiAgICAgIGxlbmd0aCA9IGFycmF5Lmxlbmd0aCxcbiAgICAgIHJlc3VsdCA9IFtdLFxuICAgICAgdmFsdWVzTGVuZ3RoID0gdmFsdWVzLmxlbmd0aDtcblxuICBpZiAoIWxlbmd0aCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgaWYgKGl0ZXJhdGVlKSB7XG4gICAgdmFsdWVzID0gYXJyYXlNYXAodmFsdWVzLCBiYXNlVW5hcnkoaXRlcmF0ZWUpKTtcbiAgfVxuICBpZiAoY29tcGFyYXRvcikge1xuICAgIGluY2x1ZGVzID0gYXJyYXlJbmNsdWRlc1dpdGg7XG4gICAgaXNDb21tb24gPSBmYWxzZTtcbiAgfVxuICBlbHNlIGlmICh2YWx1ZXMubGVuZ3RoID49IExBUkdFX0FSUkFZX1NJWkUpIHtcbiAgICBpbmNsdWRlcyA9IGNhY2hlSGFzO1xuICAgIGlzQ29tbW9uID0gZmFsc2U7XG4gICAgdmFsdWVzID0gbmV3IFNldENhY2hlKHZhbHVlcyk7XG4gIH1cbiAgb3V0ZXI6XG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgdmFyIHZhbHVlID0gYXJyYXlbaW5kZXhdLFxuICAgICAgICBjb21wdXRlZCA9IGl0ZXJhdGVlID8gaXRlcmF0ZWUodmFsdWUpIDogdmFsdWU7XG5cbiAgICBpZiAoaXNDb21tb24gJiYgY29tcHV0ZWQgPT09IGNvbXB1dGVkKSB7XG4gICAgICB2YXIgdmFsdWVzSW5kZXggPSB2YWx1ZXNMZW5ndGg7XG4gICAgICB3aGlsZSAodmFsdWVzSW5kZXgtLSkge1xuICAgICAgICBpZiAodmFsdWVzW3ZhbHVlc0luZGV4XSA9PT0gY29tcHV0ZWQpIHtcbiAgICAgICAgICBjb250aW51ZSBvdXRlcjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVzdWx0LnB1c2godmFsdWUpO1xuICAgIH1cbiAgICBlbHNlIGlmICghaW5jbHVkZXModmFsdWVzLCBjb21wdXRlZCwgY29tcGFyYXRvcikpIHtcbiAgICAgIHJlc3VsdC5wdXNoKHZhbHVlKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBiYXNlRGlmZmVyZW5jZTtcbiIsInZhciBpbmRleE9mTmFOID0gcmVxdWlyZSgnLi9faW5kZXhPZk5hTicpO1xuXG4vKipcbiAqIFRoZSBiYXNlIGltcGxlbWVudGF0aW9uIG9mIGBfLmluZGV4T2ZgIHdpdGhvdXQgYGZyb21JbmRleGAgYm91bmRzIGNoZWNrcy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIHNlYXJjaC5cbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIHNlYXJjaCBmb3IuXG4gKiBAcGFyYW0ge251bWJlcn0gZnJvbUluZGV4IFRoZSBpbmRleCB0byBzZWFyY2ggZnJvbS5cbiAqIEByZXR1cm5zIHtudW1iZXJ9IFJldHVybnMgdGhlIGluZGV4IG9mIHRoZSBtYXRjaGVkIHZhbHVlLCBlbHNlIGAtMWAuXG4gKi9cbmZ1bmN0aW9uIGJhc2VJbmRleE9mKGFycmF5LCB2YWx1ZSwgZnJvbUluZGV4KSB7XG4gIGlmICh2YWx1ZSAhPT0gdmFsdWUpIHtcbiAgICByZXR1cm4gaW5kZXhPZk5hTihhcnJheSwgZnJvbUluZGV4KTtcbiAgfVxuICB2YXIgaW5kZXggPSBmcm9tSW5kZXggLSAxLFxuICAgICAgbGVuZ3RoID0gYXJyYXkubGVuZ3RoO1xuXG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgaWYgKGFycmF5W2luZGV4XSA9PT0gdmFsdWUpIHtcbiAgICAgIHJldHVybiBpbmRleDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VJbmRleE9mO1xuIiwidmFyIFNldENhY2hlID0gcmVxdWlyZSgnLi9fU2V0Q2FjaGUnKSxcbiAgICBhcnJheUluY2x1ZGVzID0gcmVxdWlyZSgnLi9fYXJyYXlJbmNsdWRlcycpLFxuICAgIGFycmF5SW5jbHVkZXNXaXRoID0gcmVxdWlyZSgnLi9fYXJyYXlJbmNsdWRlc1dpdGgnKSxcbiAgICBhcnJheU1hcCA9IHJlcXVpcmUoJy4vX2FycmF5TWFwJyksXG4gICAgYmFzZVVuYXJ5ID0gcmVxdWlyZSgnLi9fYmFzZVVuYXJ5JyksXG4gICAgY2FjaGVIYXMgPSByZXF1aXJlKCcuL19jYWNoZUhhcycpO1xuXG4vKiBCdWlsdC1pbiBtZXRob2QgcmVmZXJlbmNlcyBmb3IgdGhvc2Ugd2l0aCB0aGUgc2FtZSBuYW1lIGFzIG90aGVyIGBsb2Rhc2hgIG1ldGhvZHMuICovXG52YXIgbmF0aXZlTWluID0gTWF0aC5taW47XG5cbi8qKlxuICogVGhlIGJhc2UgaW1wbGVtZW50YXRpb24gb2YgbWV0aG9kcyBsaWtlIGBfLmludGVyc2VjdGlvbmAsIHdpdGhvdXQgc3VwcG9ydFxuICogZm9yIGl0ZXJhdGVlIHNob3J0aGFuZHMsIHRoYXQgYWNjZXB0cyBhbiBhcnJheSBvZiBhcnJheXMgdG8gaW5zcGVjdC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXlzIFRoZSBhcnJheXMgdG8gaW5zcGVjdC5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IFtpdGVyYXRlZV0gVGhlIGl0ZXJhdGVlIGludm9rZWQgcGVyIGVsZW1lbnQuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBbY29tcGFyYXRvcl0gVGhlIGNvbXBhcmF0b3IgaW52b2tlZCBwZXIgZWxlbWVudC5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgbmV3IGFycmF5IG9mIHNoYXJlZCB2YWx1ZXMuXG4gKi9cbmZ1bmN0aW9uIGJhc2VJbnRlcnNlY3Rpb24oYXJyYXlzLCBpdGVyYXRlZSwgY29tcGFyYXRvcikge1xuICB2YXIgaW5jbHVkZXMgPSBjb21wYXJhdG9yID8gYXJyYXlJbmNsdWRlc1dpdGggOiBhcnJheUluY2x1ZGVzLFxuICAgICAgbGVuZ3RoID0gYXJyYXlzWzBdLmxlbmd0aCxcbiAgICAgIG90aExlbmd0aCA9IGFycmF5cy5sZW5ndGgsXG4gICAgICBvdGhJbmRleCA9IG90aExlbmd0aCxcbiAgICAgIGNhY2hlcyA9IEFycmF5KG90aExlbmd0aCksXG4gICAgICBtYXhMZW5ndGggPSBJbmZpbml0eSxcbiAgICAgIHJlc3VsdCA9IFtdO1xuXG4gIHdoaWxlIChvdGhJbmRleC0tKSB7XG4gICAgdmFyIGFycmF5ID0gYXJyYXlzW290aEluZGV4XTtcbiAgICBpZiAob3RoSW5kZXggJiYgaXRlcmF0ZWUpIHtcbiAgICAgIGFycmF5ID0gYXJyYXlNYXAoYXJyYXksIGJhc2VVbmFyeShpdGVyYXRlZSkpO1xuICAgIH1cbiAgICBtYXhMZW5ndGggPSBuYXRpdmVNaW4oYXJyYXkubGVuZ3RoLCBtYXhMZW5ndGgpO1xuICAgIGNhY2hlc1tvdGhJbmRleF0gPSAhY29tcGFyYXRvciAmJiAoaXRlcmF0ZWUgfHwgKGxlbmd0aCA+PSAxMjAgJiYgYXJyYXkubGVuZ3RoID49IDEyMCkpXG4gICAgICA/IG5ldyBTZXRDYWNoZShvdGhJbmRleCAmJiBhcnJheSlcbiAgICAgIDogdW5kZWZpbmVkO1xuICB9XG4gIGFycmF5ID0gYXJyYXlzWzBdO1xuXG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgc2VlbiA9IGNhY2hlc1swXTtcblxuICBvdXRlcjpcbiAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGggJiYgcmVzdWx0Lmxlbmd0aCA8IG1heExlbmd0aCkge1xuICAgIHZhciB2YWx1ZSA9IGFycmF5W2luZGV4XSxcbiAgICAgICAgY29tcHV0ZWQgPSBpdGVyYXRlZSA/IGl0ZXJhdGVlKHZhbHVlKSA6IHZhbHVlO1xuXG4gICAgaWYgKCEoc2VlblxuICAgICAgICAgID8gY2FjaGVIYXMoc2VlbiwgY29tcHV0ZWQpXG4gICAgICAgICAgOiBpbmNsdWRlcyhyZXN1bHQsIGNvbXB1dGVkLCBjb21wYXJhdG9yKVxuICAgICAgICApKSB7XG4gICAgICBvdGhJbmRleCA9IG90aExlbmd0aDtcbiAgICAgIHdoaWxlICgtLW90aEluZGV4KSB7XG4gICAgICAgIHZhciBjYWNoZSA9IGNhY2hlc1tvdGhJbmRleF07XG4gICAgICAgIGlmICghKGNhY2hlXG4gICAgICAgICAgICAgID8gY2FjaGVIYXMoY2FjaGUsIGNvbXB1dGVkKVxuICAgICAgICAgICAgICA6IGluY2x1ZGVzKGFycmF5c1tvdGhJbmRleF0sIGNvbXB1dGVkLCBjb21wYXJhdG9yKSlcbiAgICAgICAgICAgICkge1xuICAgICAgICAgIGNvbnRpbnVlIG91dGVyO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc2Vlbikge1xuICAgICAgICBzZWVuLnB1c2goY29tcHV0ZWQpO1xuICAgICAgfVxuICAgICAgcmVzdWx0LnB1c2godmFsdWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VJbnRlcnNlY3Rpb247XG4iLCIvKipcbiAqIFRoZSBiYXNlIGltcGxlbWVudGF0aW9uIG9mIGBfLnByb3BlcnR5YCB3aXRob3V0IHN1cHBvcnQgZm9yIGRlZXAgcGF0aHMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgVGhlIGtleSBvZiB0aGUgcHJvcGVydHkgdG8gZ2V0LlxuICogQHJldHVybnMge0Z1bmN0aW9ufSBSZXR1cm5zIHRoZSBuZXcgZnVuY3Rpb24uXG4gKi9cbmZ1bmN0aW9uIGJhc2VQcm9wZXJ0eShrZXkpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKG9iamVjdCkge1xuICAgIHJldHVybiBvYmplY3QgPT0gbnVsbCA/IHVuZGVmaW5lZCA6IG9iamVjdFtrZXldO1xuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VQcm9wZXJ0eTtcbiIsIi8qKlxuICogVGhlIGJhc2UgaW1wbGVtZW50YXRpb24gb2YgYF8udW5hcnlgIHdpdGhvdXQgc3VwcG9ydCBmb3Igc3RvcmluZyB3cmFwcGVyIG1ldGFkYXRhLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBmdW5jdGlvbiB0byBjYXAgYXJndW1lbnRzIGZvci5cbiAqIEByZXR1cm5zIHtGdW5jdGlvbn0gUmV0dXJucyB0aGUgbmV3IGZ1bmN0aW9uLlxuICovXG5mdW5jdGlvbiBiYXNlVW5hcnkoZnVuYykge1xuICByZXR1cm4gZnVuY3Rpb24odmFsdWUpIHtcbiAgICByZXR1cm4gZnVuYyh2YWx1ZSk7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYmFzZVVuYXJ5O1xuIiwidmFyIFNldENhY2hlID0gcmVxdWlyZSgnLi9fU2V0Q2FjaGUnKSxcbiAgICBhcnJheUluY2x1ZGVzID0gcmVxdWlyZSgnLi9fYXJyYXlJbmNsdWRlcycpLFxuICAgIGFycmF5SW5jbHVkZXNXaXRoID0gcmVxdWlyZSgnLi9fYXJyYXlJbmNsdWRlc1dpdGgnKSxcbiAgICBjYWNoZUhhcyA9IHJlcXVpcmUoJy4vX2NhY2hlSGFzJyksXG4gICAgY3JlYXRlU2V0ID0gcmVxdWlyZSgnLi9fY3JlYXRlU2V0JyksXG4gICAgc2V0VG9BcnJheSA9IHJlcXVpcmUoJy4vX3NldFRvQXJyYXknKTtcblxuLyoqIFVzZWQgYXMgdGhlIHNpemUgdG8gZW5hYmxlIGxhcmdlIGFycmF5IG9wdGltaXphdGlvbnMuICovXG52YXIgTEFSR0VfQVJSQVlfU0laRSA9IDIwMDtcblxuLyoqXG4gKiBUaGUgYmFzZSBpbXBsZW1lbnRhdGlvbiBvZiBgXy51bmlxQnlgIHdpdGhvdXQgc3VwcG9ydCBmb3IgaXRlcmF0ZWUgc2hvcnRoYW5kcy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtBcnJheX0gYXJyYXkgVGhlIGFycmF5IHRvIGluc3BlY3QuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBbaXRlcmF0ZWVdIFRoZSBpdGVyYXRlZSBpbnZva2VkIHBlciBlbGVtZW50LlxuICogQHBhcmFtIHtGdW5jdGlvbn0gW2NvbXBhcmF0b3JdIFRoZSBjb21wYXJhdG9yIGludm9rZWQgcGVyIGVsZW1lbnQuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIG5ldyBkdXBsaWNhdGUgZnJlZSBhcnJheS5cbiAqL1xuZnVuY3Rpb24gYmFzZVVuaXEoYXJyYXksIGl0ZXJhdGVlLCBjb21wYXJhdG9yKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgaW5jbHVkZXMgPSBhcnJheUluY2x1ZGVzLFxuICAgICAgbGVuZ3RoID0gYXJyYXkubGVuZ3RoLFxuICAgICAgaXNDb21tb24gPSB0cnVlLFxuICAgICAgcmVzdWx0ID0gW10sXG4gICAgICBzZWVuID0gcmVzdWx0O1xuXG4gIGlmIChjb21wYXJhdG9yKSB7XG4gICAgaXNDb21tb24gPSBmYWxzZTtcbiAgICBpbmNsdWRlcyA9IGFycmF5SW5jbHVkZXNXaXRoO1xuICB9XG4gIGVsc2UgaWYgKGxlbmd0aCA+PSBMQVJHRV9BUlJBWV9TSVpFKSB7XG4gICAgdmFyIHNldCA9IGl0ZXJhdGVlID8gbnVsbCA6IGNyZWF0ZVNldChhcnJheSk7XG4gICAgaWYgKHNldCkge1xuICAgICAgcmV0dXJuIHNldFRvQXJyYXkoc2V0KTtcbiAgICB9XG4gICAgaXNDb21tb24gPSBmYWxzZTtcbiAgICBpbmNsdWRlcyA9IGNhY2hlSGFzO1xuICAgIHNlZW4gPSBuZXcgU2V0Q2FjaGU7XG4gIH1cbiAgZWxzZSB7XG4gICAgc2VlbiA9IGl0ZXJhdGVlID8gW10gOiByZXN1bHQ7XG4gIH1cbiAgb3V0ZXI6XG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgdmFyIHZhbHVlID0gYXJyYXlbaW5kZXhdLFxuICAgICAgICBjb21wdXRlZCA9IGl0ZXJhdGVlID8gaXRlcmF0ZWUodmFsdWUpIDogdmFsdWU7XG5cbiAgICBpZiAoaXNDb21tb24gJiYgY29tcHV0ZWQgPT09IGNvbXB1dGVkKSB7XG4gICAgICB2YXIgc2VlbkluZGV4ID0gc2Vlbi5sZW5ndGg7XG4gICAgICB3aGlsZSAoc2VlbkluZGV4LS0pIHtcbiAgICAgICAgaWYgKHNlZW5bc2VlbkluZGV4XSA9PT0gY29tcHV0ZWQpIHtcbiAgICAgICAgICBjb250aW51ZSBvdXRlcjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGl0ZXJhdGVlKSB7XG4gICAgICAgIHNlZW4ucHVzaChjb21wdXRlZCk7XG4gICAgICB9XG4gICAgICByZXN1bHQucHVzaCh2YWx1ZSk7XG4gICAgfVxuICAgIGVsc2UgaWYgKCFpbmNsdWRlcyhzZWVuLCBjb21wdXRlZCwgY29tcGFyYXRvcikpIHtcbiAgICAgIGlmIChzZWVuICE9PSByZXN1bHQpIHtcbiAgICAgICAgc2Vlbi5wdXNoKGNvbXB1dGVkKTtcbiAgICAgIH1cbiAgICAgIHJlc3VsdC5wdXNoKHZhbHVlKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBiYXNlVW5pcTtcbiIsInZhciBhcnJheVB1c2ggPSByZXF1aXJlKCcuL19hcnJheVB1c2gnKSxcbiAgICBiYXNlRGlmZmVyZW5jZSA9IHJlcXVpcmUoJy4vX2Jhc2VEaWZmZXJlbmNlJyksXG4gICAgYmFzZVVuaXEgPSByZXF1aXJlKCcuL19iYXNlVW5pcScpO1xuXG4vKipcbiAqIFRoZSBiYXNlIGltcGxlbWVudGF0aW9uIG9mIG1ldGhvZHMgbGlrZSBgXy54b3JgLCB3aXRob3V0IHN1cHBvcnQgZm9yXG4gKiBpdGVyYXRlZSBzaG9ydGhhbmRzLCB0aGF0IGFjY2VwdHMgYW4gYXJyYXkgb2YgYXJyYXlzIHRvIGluc3BlY3QuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5cyBUaGUgYXJyYXlzIHRvIGluc3BlY3QuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBbaXRlcmF0ZWVdIFRoZSBpdGVyYXRlZSBpbnZva2VkIHBlciBlbGVtZW50LlxuICogQHBhcmFtIHtGdW5jdGlvbn0gW2NvbXBhcmF0b3JdIFRoZSBjb21wYXJhdG9yIGludm9rZWQgcGVyIGVsZW1lbnQuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIG5ldyBhcnJheSBvZiB2YWx1ZXMuXG4gKi9cbmZ1bmN0aW9uIGJhc2VYb3IoYXJyYXlzLCBpdGVyYXRlZSwgY29tcGFyYXRvcikge1xuICB2YXIgaW5kZXggPSAtMSxcbiAgICAgIGxlbmd0aCA9IGFycmF5cy5sZW5ndGg7XG5cbiAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGgpIHtcbiAgICB2YXIgcmVzdWx0ID0gcmVzdWx0XG4gICAgICA/IGFycmF5UHVzaChcbiAgICAgICAgICBiYXNlRGlmZmVyZW5jZShyZXN1bHQsIGFycmF5c1tpbmRleF0sIGl0ZXJhdGVlLCBjb21wYXJhdG9yKSxcbiAgICAgICAgICBiYXNlRGlmZmVyZW5jZShhcnJheXNbaW5kZXhdLCByZXN1bHQsIGl0ZXJhdGVlLCBjb21wYXJhdG9yKVxuICAgICAgICApXG4gICAgICA6IGFycmF5c1tpbmRleF07XG4gIH1cbiAgcmV0dXJuIChyZXN1bHQgJiYgcmVzdWx0Lmxlbmd0aCkgPyBiYXNlVW5pcShyZXN1bHQsIGl0ZXJhdGVlLCBjb21wYXJhdG9yKSA6IFtdO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VYb3I7XG4iLCJ2YXIgaXNLZXlhYmxlID0gcmVxdWlyZSgnLi9faXNLZXlhYmxlJyk7XG5cbi8qKiBVc2VkIHRvIHN0YW5kLWluIGZvciBgdW5kZWZpbmVkYCBoYXNoIHZhbHVlcy4gKi9cbnZhciBIQVNIX1VOREVGSU5FRCA9ICdfX2xvZGFzaF9oYXNoX3VuZGVmaW5lZF9fJztcblxuLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBpbiBgY2FjaGVgLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gY2FjaGUgVGhlIHNldCBjYWNoZSB0byBzZWFyY2guXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBzZWFyY2ggZm9yLlxuICogQHJldHVybnMge251bWJlcn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHZhbHVlYCBpcyBmb3VuZCwgZWxzZSBgZmFsc2VgLlxuICovXG5mdW5jdGlvbiBjYWNoZUhhcyhjYWNoZSwgdmFsdWUpIHtcbiAgdmFyIG1hcCA9IGNhY2hlLl9fZGF0YV9fO1xuICBpZiAoaXNLZXlhYmxlKHZhbHVlKSkge1xuICAgIHZhciBkYXRhID0gbWFwLl9fZGF0YV9fLFxuICAgICAgICBoYXNoID0gdHlwZW9mIHZhbHVlID09ICdzdHJpbmcnID8gZGF0YS5zdHJpbmcgOiBkYXRhLmhhc2g7XG5cbiAgICByZXR1cm4gaGFzaFt2YWx1ZV0gPT09IEhBU0hfVU5ERUZJTkVEO1xuICB9XG4gIHJldHVybiBtYXAuaGFzKHZhbHVlKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjYWNoZUhhcztcbiIsInZhciBpc0tleWFibGUgPSByZXF1aXJlKCcuL19pc0tleWFibGUnKTtcblxuLyoqIFVzZWQgdG8gc3RhbmQtaW4gZm9yIGB1bmRlZmluZWRgIGhhc2ggdmFsdWVzLiAqL1xudmFyIEhBU0hfVU5ERUZJTkVEID0gJ19fbG9kYXNoX2hhc2hfdW5kZWZpbmVkX18nO1xuXG4vKipcbiAqIEFkZHMgYHZhbHVlYCB0byB0aGUgc2V0IGNhY2hlLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAbmFtZSBwdXNoXG4gKiBAbWVtYmVyT2YgU2V0Q2FjaGVcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNhY2hlLlxuICovXG5mdW5jdGlvbiBjYWNoZVB1c2godmFsdWUpIHtcbiAgdmFyIG1hcCA9IHRoaXMuX19kYXRhX187XG4gIGlmIChpc0tleWFibGUodmFsdWUpKSB7XG4gICAgdmFyIGRhdGEgPSBtYXAuX19kYXRhX18sXG4gICAgICAgIGhhc2ggPSB0eXBlb2YgdmFsdWUgPT0gJ3N0cmluZycgPyBkYXRhLnN0cmluZyA6IGRhdGEuaGFzaDtcblxuICAgIGhhc2hbdmFsdWVdID0gSEFTSF9VTkRFRklORUQ7XG4gIH1cbiAgZWxzZSB7XG4gICAgbWFwLnNldCh2YWx1ZSwgSEFTSF9VTkRFRklORUQpO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY2FjaGVQdXNoO1xuIiwidmFyIGlzQXJyYXlMaWtlT2JqZWN0ID0gcmVxdWlyZSgnLi9pc0FycmF5TGlrZU9iamVjdCcpO1xuXG4vKipcbiAqIENhc3RzIGB2YWx1ZWAgdG8gYW4gZW1wdHkgYXJyYXkgaWYgaXQncyBub3QgYW4gYXJyYXkgbGlrZSBvYmplY3QuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGluc3BlY3QuXG4gKiBAcmV0dXJucyB7QXJyYXl8T2JqZWN0fSBSZXR1cm5zIHRoZSBjYXN0IGFycmF5LWxpa2Ugb2JqZWN0LlxuICovXG5mdW5jdGlvbiBjYXN0QXJyYXlMaWtlT2JqZWN0KHZhbHVlKSB7XG4gIHJldHVybiBpc0FycmF5TGlrZU9iamVjdCh2YWx1ZSkgPyB2YWx1ZSA6IFtdO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNhc3RBcnJheUxpa2VPYmplY3Q7XG4iLCIvKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIGEgZ2xvYmFsIG9iamVjdC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gY2hlY2suXG4gKiBAcmV0dXJucyB7bnVsbHxPYmplY3R9IFJldHVybnMgYHZhbHVlYCBpZiBpdCdzIGEgZ2xvYmFsIG9iamVjdCwgZWxzZSBgbnVsbGAuXG4gKi9cbmZ1bmN0aW9uIGNoZWNrR2xvYmFsKHZhbHVlKSB7XG4gIHJldHVybiAodmFsdWUgJiYgdmFsdWUuT2JqZWN0ID09PSBPYmplY3QpID8gdmFsdWUgOiBudWxsO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNoZWNrR2xvYmFsO1xuIiwidmFyIFNldCA9IHJlcXVpcmUoJy4vX1NldCcpLFxuICAgIG5vb3AgPSByZXF1aXJlKCcuL25vb3AnKTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgc2V0IG9mIGB2YWx1ZXNgLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0FycmF5fSB2YWx1ZXMgVGhlIHZhbHVlcyB0byBhZGQgdG8gdGhlIHNldC5cbiAqIEByZXR1cm5zIHtPYmplY3R9IFJldHVybnMgdGhlIG5ldyBzZXQuXG4gKi9cbnZhciBjcmVhdGVTZXQgPSAhKFNldCAmJiBuZXcgU2V0KFsxLCAyXSkuc2l6ZSA9PT0gMikgPyBub29wIDogZnVuY3Rpb24odmFsdWVzKSB7XG4gIHJldHVybiBuZXcgU2V0KHZhbHVlcyk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGNyZWF0ZVNldDtcbiIsInZhciBiYXNlUHJvcGVydHkgPSByZXF1aXJlKCcuL19iYXNlUHJvcGVydHknKTtcblxuLyoqXG4gKiBHZXRzIHRoZSBcImxlbmd0aFwiIHByb3BlcnR5IHZhbHVlIG9mIGBvYmplY3RgLlxuICpcbiAqICoqTm90ZToqKiBUaGlzIGZ1bmN0aW9uIGlzIHVzZWQgdG8gYXZvaWQgYVxuICogW0pJVCBidWddKGh0dHBzOi8vYnVncy53ZWJraXQub3JnL3Nob3dfYnVnLmNnaT9pZD0xNDI3OTIpIHRoYXQgYWZmZWN0c1xuICogU2FmYXJpIG9uIGF0IGxlYXN0IGlPUyA4LjEtOC4zIEFSTTY0LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gb2JqZWN0IFRoZSBvYmplY3QgdG8gcXVlcnkuXG4gKiBAcmV0dXJucyB7Kn0gUmV0dXJucyB0aGUgXCJsZW5ndGhcIiB2YWx1ZS5cbiAqL1xudmFyIGdldExlbmd0aCA9IGJhc2VQcm9wZXJ0eSgnbGVuZ3RoJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gZ2V0TGVuZ3RoO1xuIiwidmFyIGlzTmF0aXZlID0gcmVxdWlyZSgnLi9pc05hdGl2ZScpO1xuXG4vKipcbiAqIEdldHMgdGhlIG5hdGl2ZSBmdW5jdGlvbiBhdCBga2V5YCBvZiBgb2JqZWN0YC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtPYmplY3R9IG9iamVjdCBUaGUgb2JqZWN0IHRvIHF1ZXJ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSBtZXRob2QgdG8gZ2V0LlxuICogQHJldHVybnMgeyp9IFJldHVybnMgdGhlIGZ1bmN0aW9uIGlmIGl0J3MgbmF0aXZlLCBlbHNlIGB1bmRlZmluZWRgLlxuICovXG5mdW5jdGlvbiBnZXROYXRpdmUob2JqZWN0LCBrZXkpIHtcbiAgdmFyIHZhbHVlID0gb2JqZWN0W2tleV07XG4gIHJldHVybiBpc05hdGl2ZSh2YWx1ZSkgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBnZXROYXRpdmU7XG4iLCJ2YXIgaGFzaEhhcyA9IHJlcXVpcmUoJy4vX2hhc2hIYXMnKTtcblxuLyoqXG4gKiBSZW1vdmVzIGBrZXlgIGFuZCBpdHMgdmFsdWUgZnJvbSB0aGUgaGFzaC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHtPYmplY3R9IGhhc2ggVGhlIGhhc2ggdG8gbW9kaWZ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSB2YWx1ZSB0byByZW1vdmUuXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgdGhlIGVudHJ5IHdhcyByZW1vdmVkLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGhhc2hEZWxldGUoaGFzaCwga2V5KSB7XG4gIHJldHVybiBoYXNoSGFzKGhhc2gsIGtleSkgJiYgZGVsZXRlIGhhc2hba2V5XTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBoYXNoRGVsZXRlO1xuIiwidmFyIG5hdGl2ZUNyZWF0ZSA9IHJlcXVpcmUoJy4vX25hdGl2ZUNyZWF0ZScpO1xuXG4vKiogVXNlZCB0byBzdGFuZC1pbiBmb3IgYHVuZGVmaW5lZGAgaGFzaCB2YWx1ZXMuICovXG52YXIgSEFTSF9VTkRFRklORUQgPSAnX19sb2Rhc2hfaGFzaF91bmRlZmluZWRfXyc7XG5cbi8qKiBVc2VkIGZvciBidWlsdC1pbiBtZXRob2QgcmVmZXJlbmNlcy4gKi9cbnZhciBvYmplY3RQcm90byA9IE9iamVjdC5wcm90b3R5cGU7XG5cbi8qKiBVc2VkIHRvIGNoZWNrIG9iamVjdHMgZm9yIG93biBwcm9wZXJ0aWVzLiAqL1xudmFyIGhhc093blByb3BlcnR5ID0gb2JqZWN0UHJvdG8uaGFzT3duUHJvcGVydHk7XG5cbi8qKlxuICogR2V0cyB0aGUgaGFzaCB2YWx1ZSBmb3IgYGtleWAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBoYXNoIFRoZSBoYXNoIHRvIHF1ZXJ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSB2YWx1ZSB0byBnZXQuXG4gKiBAcmV0dXJucyB7Kn0gUmV0dXJucyB0aGUgZW50cnkgdmFsdWUuXG4gKi9cbmZ1bmN0aW9uIGhhc2hHZXQoaGFzaCwga2V5KSB7XG4gIGlmIChuYXRpdmVDcmVhdGUpIHtcbiAgICB2YXIgcmVzdWx0ID0gaGFzaFtrZXldO1xuICAgIHJldHVybiByZXN1bHQgPT09IEhBU0hfVU5ERUZJTkVEID8gdW5kZWZpbmVkIDogcmVzdWx0O1xuICB9XG4gIHJldHVybiBoYXNPd25Qcm9wZXJ0eS5jYWxsKGhhc2gsIGtleSkgPyBoYXNoW2tleV0gOiB1bmRlZmluZWQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaGFzaEdldDtcbiIsInZhciBuYXRpdmVDcmVhdGUgPSByZXF1aXJlKCcuL19uYXRpdmVDcmVhdGUnKTtcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqIFVzZWQgdG8gY2hlY2sgb2JqZWN0cyBmb3Igb3duIHByb3BlcnRpZXMuICovXG52YXIgaGFzT3duUHJvcGVydHkgPSBvYmplY3RQcm90by5oYXNPd25Qcm9wZXJ0eTtcblxuLyoqXG4gKiBDaGVja3MgaWYgYSBoYXNoIHZhbHVlIGZvciBga2V5YCBleGlzdHMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBoYXNoIFRoZSBoYXNoIHRvIHF1ZXJ5LlxuICogQHBhcmFtIHtzdHJpbmd9IGtleSBUaGUga2V5IG9mIHRoZSBlbnRyeSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBhbiBlbnRyeSBmb3IgYGtleWAgZXhpc3RzLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGhhc2hIYXMoaGFzaCwga2V5KSB7XG4gIHJldHVybiBuYXRpdmVDcmVhdGUgPyBoYXNoW2tleV0gIT09IHVuZGVmaW5lZCA6IGhhc093blByb3BlcnR5LmNhbGwoaGFzaCwga2V5KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBoYXNoSGFzO1xuIiwidmFyIG5hdGl2ZUNyZWF0ZSA9IHJlcXVpcmUoJy4vX25hdGl2ZUNyZWF0ZScpO1xuXG4vKiogVXNlZCB0byBzdGFuZC1pbiBmb3IgYHVuZGVmaW5lZGAgaGFzaCB2YWx1ZXMuICovXG52YXIgSEFTSF9VTkRFRklORUQgPSAnX19sb2Rhc2hfaGFzaF91bmRlZmluZWRfXyc7XG5cbi8qKlxuICogU2V0cyB0aGUgaGFzaCBga2V5YCB0byBgdmFsdWVgLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gaGFzaCBUaGUgaGFzaCB0byBtb2RpZnkuXG4gKiBAcGFyYW0ge3N0cmluZ30ga2V5IFRoZSBrZXkgb2YgdGhlIHZhbHVlIHRvIHNldC5cbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIHNldC5cbiAqL1xuZnVuY3Rpb24gaGFzaFNldChoYXNoLCBrZXksIHZhbHVlKSB7XG4gIGhhc2hba2V5XSA9IChuYXRpdmVDcmVhdGUgJiYgdmFsdWUgPT09IHVuZGVmaW5lZCkgPyBIQVNIX1VOREVGSU5FRCA6IHZhbHVlO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGhhc2hTZXQ7XG4iLCIvKipcbiAqIEdldHMgdGhlIGluZGV4IGF0IHdoaWNoIHRoZSBmaXJzdCBvY2N1cnJlbmNlIG9mIGBOYU5gIGlzIGZvdW5kIGluIGBhcnJheWAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBzZWFyY2guXG4gKiBAcGFyYW0ge251bWJlcn0gZnJvbUluZGV4IFRoZSBpbmRleCB0byBzZWFyY2ggZnJvbS5cbiAqIEBwYXJhbSB7Ym9vbGVhbn0gW2Zyb21SaWdodF0gU3BlY2lmeSBpdGVyYXRpbmcgZnJvbSByaWdodCB0byBsZWZ0LlxuICogQHJldHVybnMge251bWJlcn0gUmV0dXJucyB0aGUgaW5kZXggb2YgdGhlIG1hdGNoZWQgYE5hTmAsIGVsc2UgYC0xYC5cbiAqL1xuZnVuY3Rpb24gaW5kZXhPZk5hTihhcnJheSwgZnJvbUluZGV4LCBmcm9tUmlnaHQpIHtcbiAgdmFyIGxlbmd0aCA9IGFycmF5Lmxlbmd0aCxcbiAgICAgIGluZGV4ID0gZnJvbUluZGV4ICsgKGZyb21SaWdodCA/IDAgOiAtMSk7XG5cbiAgd2hpbGUgKChmcm9tUmlnaHQgPyBpbmRleC0tIDogKytpbmRleCA8IGxlbmd0aCkpIHtcbiAgICB2YXIgb3RoZXIgPSBhcnJheVtpbmRleF07XG4gICAgaWYgKG90aGVyICE9PSBvdGhlcikge1xuICAgICAgcmV0dXJuIGluZGV4O1xuICAgIH1cbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaW5kZXhPZk5hTjtcbiIsIi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgYSBob3N0IG9iamVjdCBpbiBJRSA8IDkuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYSBob3N0IG9iamVjdCwgZWxzZSBgZmFsc2VgLlxuICovXG5mdW5jdGlvbiBpc0hvc3RPYmplY3QodmFsdWUpIHtcbiAgLy8gTWFueSBob3N0IG9iamVjdHMgYXJlIGBPYmplY3RgIG9iamVjdHMgdGhhdCBjYW4gY29lcmNlIHRvIHN0cmluZ3NcbiAgLy8gZGVzcGl0ZSBoYXZpbmcgaW1wcm9wZXJseSBkZWZpbmVkIGB0b1N0cmluZ2AgbWV0aG9kcy5cbiAgdmFyIHJlc3VsdCA9IGZhbHNlO1xuICBpZiAodmFsdWUgIT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUudG9TdHJpbmcgIT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICByZXN1bHQgPSAhISh2YWx1ZSArICcnKTtcbiAgICB9IGNhdGNoIChlKSB7fVxuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNIb3N0T2JqZWN0O1xuIiwiLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBzdWl0YWJsZSBmb3IgdXNlIGFzIHVuaXF1ZSBvYmplY3Qga2V5LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBgdmFsdWVgIGlzIHN1aXRhYmxlLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGlzS2V5YWJsZSh2YWx1ZSkge1xuICB2YXIgdHlwZSA9IHR5cGVvZiB2YWx1ZTtcbiAgcmV0dXJuIHR5cGUgPT0gJ251bWJlcicgfHwgdHlwZSA9PSAnYm9vbGVhbicgfHxcbiAgICAodHlwZSA9PSAnc3RyaW5nJyAmJiB2YWx1ZSAhPSAnX19wcm90b19fJykgfHwgdmFsdWUgPT0gbnVsbDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBpc0tleWFibGU7XG4iLCJ2YXIgSGFzaCA9IHJlcXVpcmUoJy4vX0hhc2gnKSxcbiAgICBNYXAgPSByZXF1aXJlKCcuL19NYXAnKTtcblxuLyoqXG4gKiBSZW1vdmVzIGFsbCBrZXktdmFsdWUgZW50cmllcyBmcm9tIHRoZSBtYXAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBuYW1lIGNsZWFyXG4gKiBAbWVtYmVyT2YgTWFwQ2FjaGVcbiAqL1xuZnVuY3Rpb24gbWFwQ2xlYXIoKSB7XG4gIHRoaXMuX19kYXRhX18gPSB7XG4gICAgJ2hhc2gnOiBuZXcgSGFzaCxcbiAgICAnbWFwJzogTWFwID8gbmV3IE1hcCA6IFtdLFxuICAgICdzdHJpbmcnOiBuZXcgSGFzaFxuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IG1hcENsZWFyO1xuIiwidmFyIE1hcCA9IHJlcXVpcmUoJy4vX01hcCcpLFxuICAgIGFzc29jRGVsZXRlID0gcmVxdWlyZSgnLi9fYXNzb2NEZWxldGUnKSxcbiAgICBoYXNoRGVsZXRlID0gcmVxdWlyZSgnLi9faGFzaERlbGV0ZScpLFxuICAgIGlzS2V5YWJsZSA9IHJlcXVpcmUoJy4vX2lzS2V5YWJsZScpO1xuXG4vKipcbiAqIFJlbW92ZXMgYGtleWAgYW5kIGl0cyB2YWx1ZSBmcm9tIHRoZSBtYXAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBuYW1lIGRlbGV0ZVxuICogQG1lbWJlck9mIE1hcENhY2hlXG4gKiBAcGFyYW0ge3N0cmluZ30ga2V5IFRoZSBrZXkgb2YgdGhlIHZhbHVlIHRvIHJlbW92ZS5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiB0aGUgZW50cnkgd2FzIHJlbW92ZWQsIGVsc2UgYGZhbHNlYC5cbiAqL1xuZnVuY3Rpb24gbWFwRGVsZXRlKGtleSkge1xuICB2YXIgZGF0YSA9IHRoaXMuX19kYXRhX187XG4gIGlmIChpc0tleWFibGUoa2V5KSkge1xuICAgIHJldHVybiBoYXNoRGVsZXRlKHR5cGVvZiBrZXkgPT0gJ3N0cmluZycgPyBkYXRhLnN0cmluZyA6IGRhdGEuaGFzaCwga2V5KTtcbiAgfVxuICByZXR1cm4gTWFwID8gZGF0YS5tYXBbJ2RlbGV0ZSddKGtleSkgOiBhc3NvY0RlbGV0ZShkYXRhLm1hcCwga2V5KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBtYXBEZWxldGU7XG4iLCJ2YXIgTWFwID0gcmVxdWlyZSgnLi9fTWFwJyksXG4gICAgYXNzb2NHZXQgPSByZXF1aXJlKCcuL19hc3NvY0dldCcpLFxuICAgIGhhc2hHZXQgPSByZXF1aXJlKCcuL19oYXNoR2V0JyksXG4gICAgaXNLZXlhYmxlID0gcmVxdWlyZSgnLi9faXNLZXlhYmxlJyk7XG5cbi8qKlxuICogR2V0cyB0aGUgbWFwIHZhbHVlIGZvciBga2V5YC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQG5hbWUgZ2V0XG4gKiBAbWVtYmVyT2YgTWFwQ2FjaGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgVGhlIGtleSBvZiB0aGUgdmFsdWUgdG8gZ2V0LlxuICogQHJldHVybnMgeyp9IFJldHVybnMgdGhlIGVudHJ5IHZhbHVlLlxuICovXG5mdW5jdGlvbiBtYXBHZXQoa2V5KSB7XG4gIHZhciBkYXRhID0gdGhpcy5fX2RhdGFfXztcbiAgaWYgKGlzS2V5YWJsZShrZXkpKSB7XG4gICAgcmV0dXJuIGhhc2hHZXQodHlwZW9mIGtleSA9PSAnc3RyaW5nJyA/IGRhdGEuc3RyaW5nIDogZGF0YS5oYXNoLCBrZXkpO1xuICB9XG4gIHJldHVybiBNYXAgPyBkYXRhLm1hcC5nZXQoa2V5KSA6IGFzc29jR2V0KGRhdGEubWFwLCBrZXkpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IG1hcEdldDtcbiIsInZhciBNYXAgPSByZXF1aXJlKCcuL19NYXAnKSxcbiAgICBhc3NvY0hhcyA9IHJlcXVpcmUoJy4vX2Fzc29jSGFzJyksXG4gICAgaGFzaEhhcyA9IHJlcXVpcmUoJy4vX2hhc2hIYXMnKSxcbiAgICBpc0tleWFibGUgPSByZXF1aXJlKCcuL19pc0tleWFibGUnKTtcblxuLyoqXG4gKiBDaGVja3MgaWYgYSBtYXAgdmFsdWUgZm9yIGBrZXlgIGV4aXN0cy5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQG5hbWUgaGFzXG4gKiBAbWVtYmVyT2YgTWFwQ2FjaGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgVGhlIGtleSBvZiB0aGUgZW50cnkgdG8gY2hlY2suXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYW4gZW50cnkgZm9yIGBrZXlgIGV4aXN0cywgZWxzZSBgZmFsc2VgLlxuICovXG5mdW5jdGlvbiBtYXBIYXMoa2V5KSB7XG4gIHZhciBkYXRhID0gdGhpcy5fX2RhdGFfXztcbiAgaWYgKGlzS2V5YWJsZShrZXkpKSB7XG4gICAgcmV0dXJuIGhhc2hIYXModHlwZW9mIGtleSA9PSAnc3RyaW5nJyA/IGRhdGEuc3RyaW5nIDogZGF0YS5oYXNoLCBrZXkpO1xuICB9XG4gIHJldHVybiBNYXAgPyBkYXRhLm1hcC5oYXMoa2V5KSA6IGFzc29jSGFzKGRhdGEubWFwLCBrZXkpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IG1hcEhhcztcbiIsInZhciBNYXAgPSByZXF1aXJlKCcuL19NYXAnKSxcbiAgICBhc3NvY1NldCA9IHJlcXVpcmUoJy4vX2Fzc29jU2V0JyksXG4gICAgaGFzaFNldCA9IHJlcXVpcmUoJy4vX2hhc2hTZXQnKSxcbiAgICBpc0tleWFibGUgPSByZXF1aXJlKCcuL19pc0tleWFibGUnKTtcblxuLyoqXG4gKiBTZXRzIHRoZSBtYXAgYGtleWAgdG8gYHZhbHVlYC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQG5hbWUgc2V0XG4gKiBAbWVtYmVyT2YgTWFwQ2FjaGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBrZXkgVGhlIGtleSBvZiB0aGUgdmFsdWUgdG8gc2V0LlxuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gc2V0LlxuICogQHJldHVybnMge09iamVjdH0gUmV0dXJucyB0aGUgbWFwIGNhY2hlIGluc3RhbmNlLlxuICovXG5mdW5jdGlvbiBtYXBTZXQoa2V5LCB2YWx1ZSkge1xuICB2YXIgZGF0YSA9IHRoaXMuX19kYXRhX187XG4gIGlmIChpc0tleWFibGUoa2V5KSkge1xuICAgIGhhc2hTZXQodHlwZW9mIGtleSA9PSAnc3RyaW5nJyA/IGRhdGEuc3RyaW5nIDogZGF0YS5oYXNoLCBrZXksIHZhbHVlKTtcbiAgfSBlbHNlIGlmIChNYXApIHtcbiAgICBkYXRhLm1hcC5zZXQoa2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgYXNzb2NTZXQoZGF0YS5tYXAsIGtleSwgdmFsdWUpO1xuICB9XG4gIHJldHVybiB0aGlzO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IG1hcFNldDtcbiIsInZhciBnZXROYXRpdmUgPSByZXF1aXJlKCcuL19nZXROYXRpdmUnKTtcblxuLyogQnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMgdGhhdCBhcmUgdmVyaWZpZWQgdG8gYmUgbmF0aXZlLiAqL1xudmFyIG5hdGl2ZUNyZWF0ZSA9IGdldE5hdGl2ZShPYmplY3QsICdjcmVhdGUnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBuYXRpdmVDcmVhdGU7XG4iLCJ2YXIgY2hlY2tHbG9iYWwgPSByZXF1aXJlKCcuL19jaGVja0dsb2JhbCcpO1xuXG4vKiogVXNlZCB0byBkZXRlcm1pbmUgaWYgdmFsdWVzIGFyZSBvZiB0aGUgbGFuZ3VhZ2UgdHlwZSBgT2JqZWN0YC4gKi9cbnZhciBvYmplY3RUeXBlcyA9IHtcbiAgJ2Z1bmN0aW9uJzogdHJ1ZSxcbiAgJ29iamVjdCc6IHRydWVcbn07XG5cbi8qKiBEZXRlY3QgZnJlZSB2YXJpYWJsZSBgZXhwb3J0c2AuICovXG52YXIgZnJlZUV4cG9ydHMgPSAob2JqZWN0VHlwZXNbdHlwZW9mIGV4cG9ydHNdICYmIGV4cG9ydHMgJiYgIWV4cG9ydHMubm9kZVR5cGUpXG4gID8gZXhwb3J0c1xuICA6IHVuZGVmaW5lZDtcblxuLyoqIERldGVjdCBmcmVlIHZhcmlhYmxlIGBtb2R1bGVgLiAqL1xudmFyIGZyZWVNb2R1bGUgPSAob2JqZWN0VHlwZXNbdHlwZW9mIG1vZHVsZV0gJiYgbW9kdWxlICYmICFtb2R1bGUubm9kZVR5cGUpXG4gID8gbW9kdWxlXG4gIDogdW5kZWZpbmVkO1xuXG4vKiogRGV0ZWN0IGZyZWUgdmFyaWFibGUgYGdsb2JhbGAgZnJvbSBOb2RlLmpzLiAqL1xudmFyIGZyZWVHbG9iYWwgPSBjaGVja0dsb2JhbChmcmVlRXhwb3J0cyAmJiBmcmVlTW9kdWxlICYmIHR5cGVvZiBnbG9iYWwgPT0gJ29iamVjdCcgJiYgZ2xvYmFsKTtcblxuLyoqIERldGVjdCBmcmVlIHZhcmlhYmxlIGBzZWxmYC4gKi9cbnZhciBmcmVlU2VsZiA9IGNoZWNrR2xvYmFsKG9iamVjdFR5cGVzW3R5cGVvZiBzZWxmXSAmJiBzZWxmKTtcblxuLyoqIERldGVjdCBmcmVlIHZhcmlhYmxlIGB3aW5kb3dgLiAqL1xudmFyIGZyZWVXaW5kb3cgPSBjaGVja0dsb2JhbChvYmplY3RUeXBlc1t0eXBlb2Ygd2luZG93XSAmJiB3aW5kb3cpO1xuXG4vKiogRGV0ZWN0IGB0aGlzYCBhcyB0aGUgZ2xvYmFsIG9iamVjdC4gKi9cbnZhciB0aGlzR2xvYmFsID0gY2hlY2tHbG9iYWwob2JqZWN0VHlwZXNbdHlwZW9mIHRoaXNdICYmIHRoaXMpO1xuXG4vKipcbiAqIFVzZWQgYXMgYSByZWZlcmVuY2UgdG8gdGhlIGdsb2JhbCBvYmplY3QuXG4gKlxuICogVGhlIGB0aGlzYCB2YWx1ZSBpcyB1c2VkIGlmIGl0J3MgdGhlIGdsb2JhbCBvYmplY3QgdG8gYXZvaWQgR3JlYXNlbW9ua2V5J3NcbiAqIHJlc3RyaWN0ZWQgYHdpbmRvd2Agb2JqZWN0LCBvdGhlcndpc2UgdGhlIGB3aW5kb3dgIG9iamVjdCBpcyB1c2VkLlxuICovXG52YXIgcm9vdCA9IGZyZWVHbG9iYWwgfHxcbiAgKChmcmVlV2luZG93ICE9PSAodGhpc0dsb2JhbCAmJiB0aGlzR2xvYmFsLndpbmRvdykpICYmIGZyZWVXaW5kb3cpIHx8XG4gICAgZnJlZVNlbGYgfHwgdGhpc0dsb2JhbCB8fCBGdW5jdGlvbigncmV0dXJuIHRoaXMnKSgpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHJvb3Q7XG4iLCIvKipcbiAqIENvbnZlcnRzIGBzZXRgIHRvIGFuIGFycmF5LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gc2V0IFRoZSBzZXQgdG8gY29udmVydC5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgY29udmVydGVkIGFycmF5LlxuICovXG5mdW5jdGlvbiBzZXRUb0FycmF5KHNldCkge1xuICB2YXIgaW5kZXggPSAtMSxcbiAgICAgIHJlc3VsdCA9IEFycmF5KHNldC5zaXplKTtcblxuICBzZXQuZm9yRWFjaChmdW5jdGlvbih2YWx1ZSkge1xuICAgIHJlc3VsdFsrK2luZGV4XSA9IHZhbHVlO1xuICB9KTtcbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBzZXRUb0FycmF5O1xuIiwiLyoqIFVzZWQgdG8gcmVzb2x2ZSB0aGUgZGVjb21waWxlZCBzb3VyY2Ugb2YgZnVuY3Rpb25zLiAqL1xudmFyIGZ1bmNUb1N0cmluZyA9IEZ1bmN0aW9uLnByb3RvdHlwZS50b1N0cmluZztcblxuLyoqXG4gKiBDb252ZXJ0cyBgZnVuY2AgdG8gaXRzIHNvdXJjZSBjb2RlLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBmdW5jdGlvbiB0byBwcm9jZXNzLlxuICogQHJldHVybnMge3N0cmluZ30gUmV0dXJucyB0aGUgc291cmNlIGNvZGUuXG4gKi9cbmZ1bmN0aW9uIHRvU291cmNlKGZ1bmMpIHtcbiAgaWYgKGZ1bmMgIT0gbnVsbCkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gZnVuY1RvU3RyaW5nLmNhbGwoZnVuYyk7XG4gICAgfSBjYXRjaCAoZSkge31cbiAgICB0cnkge1xuICAgICAgcmV0dXJuIChmdW5jICsgJycpO1xuICAgIH0gY2F0Y2ggKGUpIHt9XG4gIH1cbiAgcmV0dXJuICcnO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHRvU291cmNlO1xuIiwiLyoqXG4gKiBQZXJmb3JtcyBhXG4gKiBbYFNhbWVWYWx1ZVplcm9gXShodHRwOi8vZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy1zYW1ldmFsdWV6ZXJvKVxuICogY29tcGFyaXNvbiBiZXR3ZWVuIHR3byB2YWx1ZXMgdG8gZGV0ZXJtaW5lIGlmIHRoZXkgYXJlIGVxdWl2YWxlbnQuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNvbXBhcmUuXG4gKiBAcGFyYW0geyp9IG90aGVyIFRoZSBvdGhlciB2YWx1ZSB0byBjb21wYXJlLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIHRoZSB2YWx1ZXMgYXJlIGVxdWl2YWxlbnQsIGVsc2UgYGZhbHNlYC5cbiAqIEBleGFtcGxlXG4gKlxuICogdmFyIG9iamVjdCA9IHsgJ3VzZXInOiAnZnJlZCcgfTtcbiAqIHZhciBvdGhlciA9IHsgJ3VzZXInOiAnZnJlZCcgfTtcbiAqXG4gKiBfLmVxKG9iamVjdCwgb2JqZWN0KTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmVxKG9iamVjdCwgb3RoZXIpO1xuICogLy8gPT4gZmFsc2VcbiAqXG4gKiBfLmVxKCdhJywgJ2EnKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmVxKCdhJywgT2JqZWN0KCdhJykpO1xuICogLy8gPT4gZmFsc2VcbiAqXG4gKiBfLmVxKE5hTiwgTmFOKTtcbiAqIC8vID0+IHRydWVcbiAqL1xuZnVuY3Rpb24gZXEodmFsdWUsIG90aGVyKSB7XG4gIHJldHVybiB2YWx1ZSA9PT0gb3RoZXIgfHwgKHZhbHVlICE9PSB2YWx1ZSAmJiBvdGhlciAhPT0gb3RoZXIpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGVxO1xuIiwidmFyIGFycmF5TWFwID0gcmVxdWlyZSgnLi9fYXJyYXlNYXAnKSxcbiAgICBiYXNlSW50ZXJzZWN0aW9uID0gcmVxdWlyZSgnLi9fYmFzZUludGVyc2VjdGlvbicpLFxuICAgIGNhc3RBcnJheUxpa2VPYmplY3QgPSByZXF1aXJlKCcuL19jYXN0QXJyYXlMaWtlT2JqZWN0JyksXG4gICAgcmVzdCA9IHJlcXVpcmUoJy4vcmVzdCcpO1xuXG4vKipcbiAqIENyZWF0ZXMgYW4gYXJyYXkgb2YgdW5pcXVlIHZhbHVlcyB0aGF0IGFyZSBpbmNsdWRlZCBpbiBhbGwgZ2l2ZW4gYXJyYXlzXG4gKiB1c2luZyBbYFNhbWVWYWx1ZVplcm9gXShodHRwOi8vZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy1zYW1ldmFsdWV6ZXJvKVxuICogZm9yIGVxdWFsaXR5IGNvbXBhcmlzb25zLiBUaGUgb3JkZXIgb2YgcmVzdWx0IHZhbHVlcyBpcyBkZXRlcm1pbmVkIGJ5IHRoZVxuICogb3JkZXIgdGhleSBvY2N1ciBpbiB0aGUgZmlyc3QgYXJyYXkuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAwLjEuMFxuICogQGNhdGVnb3J5IEFycmF5XG4gKiBAcGFyYW0gey4uLkFycmF5fSBbYXJyYXlzXSBUaGUgYXJyYXlzIHRvIGluc3BlY3QuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIG5ldyBhcnJheSBvZiBpbnRlcnNlY3RpbmcgdmFsdWVzLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmludGVyc2VjdGlvbihbMiwgMV0sIFs0LCAyXSwgWzEsIDJdKTtcbiAqIC8vID0+IFsyXVxuICovXG52YXIgaW50ZXJzZWN0aW9uID0gcmVzdChmdW5jdGlvbihhcnJheXMpIHtcbiAgdmFyIG1hcHBlZCA9IGFycmF5TWFwKGFycmF5cywgY2FzdEFycmF5TGlrZU9iamVjdCk7XG4gIHJldHVybiAobWFwcGVkLmxlbmd0aCAmJiBtYXBwZWRbMF0gPT09IGFycmF5c1swXSlcbiAgICA/IGJhc2VJbnRlcnNlY3Rpb24obWFwcGVkKVxuICAgIDogW107XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBpbnRlcnNlY3Rpb247XG4iLCIvKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIGNsYXNzaWZpZWQgYXMgYW4gYEFycmF5YCBvYmplY3QuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAwLjEuMFxuICogQHR5cGUge0Z1bmN0aW9ufVxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgY29ycmVjdGx5IGNsYXNzaWZpZWQsXG4gKiAgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmlzQXJyYXkoWzEsIDIsIDNdKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzQXJyYXkoZG9jdW1lbnQuYm9keS5jaGlsZHJlbik7XG4gKiAvLyA9PiBmYWxzZVxuICpcbiAqIF8uaXNBcnJheSgnYWJjJyk7XG4gKiAvLyA9PiBmYWxzZVxuICpcbiAqIF8uaXNBcnJheShfLm5vb3ApO1xuICogLy8gPT4gZmFsc2VcbiAqL1xudmFyIGlzQXJyYXkgPSBBcnJheS5pc0FycmF5O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGlzQXJyYXk7XG4iLCJ2YXIgZ2V0TGVuZ3RoID0gcmVxdWlyZSgnLi9fZ2V0TGVuZ3RoJyksXG4gICAgaXNGdW5jdGlvbiA9IHJlcXVpcmUoJy4vaXNGdW5jdGlvbicpLFxuICAgIGlzTGVuZ3RoID0gcmVxdWlyZSgnLi9pc0xlbmd0aCcpO1xuXG4vKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIGFycmF5LWxpa2UuIEEgdmFsdWUgaXMgY29uc2lkZXJlZCBhcnJheS1saWtlIGlmIGl0J3NcbiAqIG5vdCBhIGZ1bmN0aW9uIGFuZCBoYXMgYSBgdmFsdWUubGVuZ3RoYCB0aGF0J3MgYW4gaW50ZWdlciBncmVhdGVyIHRoYW4gb3JcbiAqIGVxdWFsIHRvIGAwYCBhbmQgbGVzcyB0aGFuIG9yIGVxdWFsIHRvIGBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUmAuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYXJyYXktbGlrZSwgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmlzQXJyYXlMaWtlKFsxLCAyLCAzXSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc0FycmF5TGlrZShkb2N1bWVudC5ib2R5LmNoaWxkcmVuKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzQXJyYXlMaWtlKCdhYmMnKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzQXJyYXlMaWtlKF8ubm9vcCk7XG4gKiAvLyA9PiBmYWxzZVxuICovXG5mdW5jdGlvbiBpc0FycmF5TGlrZSh2YWx1ZSkge1xuICByZXR1cm4gdmFsdWUgIT0gbnVsbCAmJiBpc0xlbmd0aChnZXRMZW5ndGgodmFsdWUpKSAmJiAhaXNGdW5jdGlvbih2YWx1ZSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNBcnJheUxpa2U7XG4iLCJ2YXIgaXNBcnJheUxpa2UgPSByZXF1aXJlKCcuL2lzQXJyYXlMaWtlJyksXG4gICAgaXNPYmplY3RMaWtlID0gcmVxdWlyZSgnLi9pc09iamVjdExpa2UnKTtcblxuLyoqXG4gKiBUaGlzIG1ldGhvZCBpcyBsaWtlIGBfLmlzQXJyYXlMaWtlYCBleGNlcHQgdGhhdCBpdCBhbHNvIGNoZWNrcyBpZiBgdmFsdWVgXG4gKiBpcyBhbiBvYmplY3QuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYW4gYXJyYXktbGlrZSBvYmplY3QsXG4gKiAgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmlzQXJyYXlMaWtlT2JqZWN0KFsxLCAyLCAzXSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc0FycmF5TGlrZU9iamVjdChkb2N1bWVudC5ib2R5LmNoaWxkcmVuKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzQXJyYXlMaWtlT2JqZWN0KCdhYmMnKTtcbiAqIC8vID0+IGZhbHNlXG4gKlxuICogXy5pc0FycmF5TGlrZU9iamVjdChfLm5vb3ApO1xuICogLy8gPT4gZmFsc2VcbiAqL1xuZnVuY3Rpb24gaXNBcnJheUxpa2VPYmplY3QodmFsdWUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0TGlrZSh2YWx1ZSkgJiYgaXNBcnJheUxpa2UodmFsdWUpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzQXJyYXlMaWtlT2JqZWN0O1xuIiwidmFyIGlzT2JqZWN0ID0gcmVxdWlyZSgnLi9pc09iamVjdCcpO1xuXG4vKiogYE9iamVjdCN0b1N0cmluZ2AgcmVzdWx0IHJlZmVyZW5jZXMuICovXG52YXIgZnVuY1RhZyA9ICdbb2JqZWN0IEZ1bmN0aW9uXScsXG4gICAgZ2VuVGFnID0gJ1tvYmplY3QgR2VuZXJhdG9yRnVuY3Rpb25dJztcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqXG4gKiBVc2VkIHRvIHJlc29sdmUgdGhlXG4gKiBbYHRvU3RyaW5nVGFnYF0oaHR0cDovL2VjbWEtaW50ZXJuYXRpb25hbC5vcmcvZWNtYS0yNjIvNi4wLyNzZWMtb2JqZWN0LnByb3RvdHlwZS50b3N0cmluZylcbiAqIG9mIHZhbHVlcy5cbiAqL1xudmFyIG9iamVjdFRvU3RyaW5nID0gb2JqZWN0UHJvdG8udG9TdHJpbmc7XG5cbi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgY2xhc3NpZmllZCBhcyBhIGBGdW5jdGlvbmAgb2JqZWN0LlxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgMC4xLjBcbiAqIEBjYXRlZ29yeSBMYW5nXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBgdmFsdWVgIGlzIGNvcnJlY3RseSBjbGFzc2lmaWVkLFxuICogIGVsc2UgYGZhbHNlYC5cbiAqIEBleGFtcGxlXG4gKlxuICogXy5pc0Z1bmN0aW9uKF8pO1xuICogLy8gPT4gdHJ1ZVxuICpcbiAqIF8uaXNGdW5jdGlvbigvYWJjLyk7XG4gKiAvLyA9PiBmYWxzZVxuICovXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKHZhbHVlKSB7XG4gIC8vIFRoZSB1c2Ugb2YgYE9iamVjdCN0b1N0cmluZ2AgYXZvaWRzIGlzc3VlcyB3aXRoIHRoZSBgdHlwZW9mYCBvcGVyYXRvclxuICAvLyBpbiBTYWZhcmkgOCB3aGljaCByZXR1cm5zICdvYmplY3QnIGZvciB0eXBlZCBhcnJheSBhbmQgd2VhayBtYXAgY29uc3RydWN0b3JzLFxuICAvLyBhbmQgUGhhbnRvbUpTIDEuOSB3aGljaCByZXR1cm5zICdmdW5jdGlvbicgZm9yIGBOb2RlTGlzdGAgaW5zdGFuY2VzLlxuICB2YXIgdGFnID0gaXNPYmplY3QodmFsdWUpID8gb2JqZWN0VG9TdHJpbmcuY2FsbCh2YWx1ZSkgOiAnJztcbiAgcmV0dXJuIHRhZyA9PSBmdW5jVGFnIHx8IHRhZyA9PSBnZW5UYWc7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNGdW5jdGlvbjtcbiIsIi8qKiBVc2VkIGFzIHJlZmVyZW5jZXMgZm9yIHZhcmlvdXMgYE51bWJlcmAgY29uc3RhbnRzLiAqL1xudmFyIE1BWF9TQUZFX0lOVEVHRVIgPSA5MDA3MTk5MjU0NzQwOTkxO1xuXG4vKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIGEgdmFsaWQgYXJyYXktbGlrZSBsZW5ndGguXG4gKlxuICogKipOb3RlOioqIFRoaXMgZnVuY3Rpb24gaXMgbG9vc2VseSBiYXNlZCBvblxuICogW2BUb0xlbmd0aGBdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLXRvbGVuZ3RoKS5cbiAqXG4gKiBAc3RhdGljXG4gKiBAbWVtYmVyT2YgX1xuICogQHNpbmNlIDQuMC4wXG4gKiBAY2F0ZWdvcnkgTGFuZ1xuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gY2hlY2suXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHZhbHVlYCBpcyBhIHZhbGlkIGxlbmd0aCxcbiAqICBlbHNlIGBmYWxzZWAuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8uaXNMZW5ndGgoMyk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc0xlbmd0aChOdW1iZXIuTUlOX1ZBTFVFKTtcbiAqIC8vID0+IGZhbHNlXG4gKlxuICogXy5pc0xlbmd0aChJbmZpbml0eSk7XG4gKiAvLyA9PiBmYWxzZVxuICpcbiAqIF8uaXNMZW5ndGgoJzMnKTtcbiAqIC8vID0+IGZhbHNlXG4gKi9cbmZ1bmN0aW9uIGlzTGVuZ3RoKHZhbHVlKSB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT0gJ251bWJlcicgJiZcbiAgICB2YWx1ZSA+IC0xICYmIHZhbHVlICUgMSA9PSAwICYmIHZhbHVlIDw9IE1BWF9TQUZFX0lOVEVHRVI7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNMZW5ndGg7XG4iLCJ2YXIgaXNGdW5jdGlvbiA9IHJlcXVpcmUoJy4vaXNGdW5jdGlvbicpLFxuICAgIGlzSG9zdE9iamVjdCA9IHJlcXVpcmUoJy4vX2lzSG9zdE9iamVjdCcpLFxuICAgIGlzT2JqZWN0ID0gcmVxdWlyZSgnLi9pc09iamVjdCcpLFxuICAgIHRvU291cmNlID0gcmVxdWlyZSgnLi9fdG9Tb3VyY2UnKTtcblxuLyoqXG4gKiBVc2VkIHRvIG1hdGNoIGBSZWdFeHBgXG4gKiBbc3ludGF4IGNoYXJhY3RlcnNdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLXBhdHRlcm5zKS5cbiAqL1xudmFyIHJlUmVnRXhwQ2hhciA9IC9bXFxcXF4kLiorPygpW1xcXXt9fF0vZztcblxuLyoqIFVzZWQgdG8gZGV0ZWN0IGhvc3QgY29uc3RydWN0b3JzIChTYWZhcmkpLiAqL1xudmFyIHJlSXNIb3N0Q3RvciA9IC9eXFxbb2JqZWN0IC4rP0NvbnN0cnVjdG9yXFxdJC87XG5cbi8qKiBVc2VkIGZvciBidWlsdC1pbiBtZXRob2QgcmVmZXJlbmNlcy4gKi9cbnZhciBvYmplY3RQcm90byA9IE9iamVjdC5wcm90b3R5cGU7XG5cbi8qKiBVc2VkIHRvIHJlc29sdmUgdGhlIGRlY29tcGlsZWQgc291cmNlIG9mIGZ1bmN0aW9ucy4gKi9cbnZhciBmdW5jVG9TdHJpbmcgPSBGdW5jdGlvbi5wcm90b3R5cGUudG9TdHJpbmc7XG5cbi8qKiBVc2VkIHRvIGNoZWNrIG9iamVjdHMgZm9yIG93biBwcm9wZXJ0aWVzLiAqL1xudmFyIGhhc093blByb3BlcnR5ID0gb2JqZWN0UHJvdG8uaGFzT3duUHJvcGVydHk7XG5cbi8qKiBVc2VkIHRvIGRldGVjdCBpZiBhIG1ldGhvZCBpcyBuYXRpdmUuICovXG52YXIgcmVJc05hdGl2ZSA9IFJlZ0V4cCgnXicgK1xuICBmdW5jVG9TdHJpbmcuY2FsbChoYXNPd25Qcm9wZXJ0eSkucmVwbGFjZShyZVJlZ0V4cENoYXIsICdcXFxcJCYnKVxuICAucmVwbGFjZSgvaGFzT3duUHJvcGVydHl8KGZ1bmN0aW9uKS4qPyg/PVxcXFxcXCgpfCBmb3IgLis/KD89XFxcXFxcXSkvZywgJyQxLio/JykgKyAnJCdcbik7XG5cbi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgYSBuYXRpdmUgZnVuY3Rpb24uXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAzLjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYSBuYXRpdmUgZnVuY3Rpb24sXG4gKiAgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmlzTmF0aXZlKEFycmF5LnByb3RvdHlwZS5wdXNoKTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzTmF0aXZlKF8pO1xuICogLy8gPT4gZmFsc2VcbiAqL1xuZnVuY3Rpb24gaXNOYXRpdmUodmFsdWUpIHtcbiAgaWYgKCFpc09iamVjdCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdmFyIHBhdHRlcm4gPSAoaXNGdW5jdGlvbih2YWx1ZSkgfHwgaXNIb3N0T2JqZWN0KHZhbHVlKSkgPyByZUlzTmF0aXZlIDogcmVJc0hvc3RDdG9yO1xuICByZXR1cm4gcGF0dGVybi50ZXN0KHRvU291cmNlKHZhbHVlKSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNOYXRpdmU7XG4iLCIvKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIHRoZVxuICogW2xhbmd1YWdlIHR5cGVdKGh0dHA6Ly93d3cuZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy1lY21hc2NyaXB0LWxhbmd1YWdlLXR5cGVzKVxuICogb2YgYE9iamVjdGAuIChlLmcuIGFycmF5cywgZnVuY3Rpb25zLCBvYmplY3RzLCByZWdleGVzLCBgbmV3IE51bWJlcigwKWAsIGFuZCBgbmV3IFN0cmluZygnJylgKVxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgMC4xLjBcbiAqIEBjYXRlZ29yeSBMYW5nXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBgdmFsdWVgIGlzIGFuIG9iamVjdCwgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmlzT2JqZWN0KHt9KTtcbiAqIC8vID0+IHRydWVcbiAqXG4gKiBfLmlzT2JqZWN0KFsxLCAyLCAzXSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc09iamVjdChfLm5vb3ApO1xuICogLy8gPT4gdHJ1ZVxuICpcbiAqIF8uaXNPYmplY3QobnVsbCk7XG4gKiAvLyA9PiBmYWxzZVxuICovXG5mdW5jdGlvbiBpc09iamVjdCh2YWx1ZSkge1xuICB2YXIgdHlwZSA9IHR5cGVvZiB2YWx1ZTtcbiAgcmV0dXJuICEhdmFsdWUgJiYgKHR5cGUgPT0gJ29iamVjdCcgfHwgdHlwZSA9PSAnZnVuY3Rpb24nKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBpc09iamVjdDtcbiIsIi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgb2JqZWN0LWxpa2UuIEEgdmFsdWUgaXMgb2JqZWN0LWxpa2UgaWYgaXQncyBub3QgYG51bGxgXG4gKiBhbmQgaGFzIGEgYHR5cGVvZmAgcmVzdWx0IG9mIFwib2JqZWN0XCIuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgb2JqZWN0LWxpa2UsIGVsc2UgYGZhbHNlYC5cbiAqIEBleGFtcGxlXG4gKlxuICogXy5pc09iamVjdExpa2Uoe30pO1xuICogLy8gPT4gdHJ1ZVxuICpcbiAqIF8uaXNPYmplY3RMaWtlKFsxLCAyLCAzXSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc09iamVjdExpa2UoXy5ub29wKTtcbiAqIC8vID0+IGZhbHNlXG4gKlxuICogXy5pc09iamVjdExpa2UobnVsbCk7XG4gKiAvLyA9PiBmYWxzZVxuICovXG5mdW5jdGlvbiBpc09iamVjdExpa2UodmFsdWUpIHtcbiAgcmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09ICdvYmplY3QnO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzT2JqZWN0TGlrZTtcbiIsInZhciBpc09iamVjdExpa2UgPSByZXF1aXJlKCcuL2lzT2JqZWN0TGlrZScpO1xuXG4vKiogYE9iamVjdCN0b1N0cmluZ2AgcmVzdWx0IHJlZmVyZW5jZXMuICovXG52YXIgc3ltYm9sVGFnID0gJ1tvYmplY3QgU3ltYm9sXSc7XG5cbi8qKiBVc2VkIGZvciBidWlsdC1pbiBtZXRob2QgcmVmZXJlbmNlcy4gKi9cbnZhciBvYmplY3RQcm90byA9IE9iamVjdC5wcm90b3R5cGU7XG5cbi8qKlxuICogVXNlZCB0byByZXNvbHZlIHRoZVxuICogW2B0b1N0cmluZ1RhZ2BdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLW9iamVjdC5wcm90b3R5cGUudG9zdHJpbmcpXG4gKiBvZiB2YWx1ZXMuXG4gKi9cbnZhciBvYmplY3RUb1N0cmluZyA9IG9iamVjdFByb3RvLnRvU3RyaW5nO1xuXG4vKipcbiAqIENoZWNrcyBpZiBgdmFsdWVgIGlzIGNsYXNzaWZpZWQgYXMgYSBgU3ltYm9sYCBwcmltaXRpdmUgb3Igb2JqZWN0LlxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgNC4wLjBcbiAqIEBjYXRlZ29yeSBMYW5nXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBgdmFsdWVgIGlzIGNvcnJlY3RseSBjbGFzc2lmaWVkLFxuICogIGVsc2UgYGZhbHNlYC5cbiAqIEBleGFtcGxlXG4gKlxuICogXy5pc1N5bWJvbChTeW1ib2wuaXRlcmF0b3IpO1xuICogLy8gPT4gdHJ1ZVxuICpcbiAqIF8uaXNTeW1ib2woJ2FiYycpO1xuICogLy8gPT4gZmFsc2VcbiAqL1xuZnVuY3Rpb24gaXNTeW1ib2wodmFsdWUpIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PSAnc3ltYm9sJyB8fFxuICAgIChpc09iamVjdExpa2UodmFsdWUpICYmIG9iamVjdFRvU3RyaW5nLmNhbGwodmFsdWUpID09IHN5bWJvbFRhZyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNTeW1ib2w7XG4iLCIvKipcbiAqIEEgbm8tb3BlcmF0aW9uIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBgdW5kZWZpbmVkYCByZWdhcmRsZXNzIG9mIHRoZVxuICogYXJndW1lbnRzIGl0IHJlY2VpdmVzLlxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgMi4zLjBcbiAqIEBjYXRlZ29yeSBVdGlsXG4gKiBAZXhhbXBsZVxuICpcbiAqIHZhciBvYmplY3QgPSB7ICd1c2VyJzogJ2ZyZWQnIH07XG4gKlxuICogXy5ub29wKG9iamVjdCkgPT09IHVuZGVmaW5lZDtcbiAqIC8vID0+IHRydWVcbiAqL1xuZnVuY3Rpb24gbm9vcCgpIHtcbiAgLy8gTm8gb3BlcmF0aW9uIHBlcmZvcm1lZC5cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBub29wO1xuIiwidmFyIGFwcGx5ID0gcmVxdWlyZSgnLi9fYXBwbHknKSxcbiAgICB0b0ludGVnZXIgPSByZXF1aXJlKCcuL3RvSW50ZWdlcicpO1xuXG4vKiogVXNlZCBhcyB0aGUgYFR5cGVFcnJvcmAgbWVzc2FnZSBmb3IgXCJGdW5jdGlvbnNcIiBtZXRob2RzLiAqL1xudmFyIEZVTkNfRVJST1JfVEVYVCA9ICdFeHBlY3RlZCBhIGZ1bmN0aW9uJztcblxuLyogQnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMgZm9yIHRob3NlIHdpdGggdGhlIHNhbWUgbmFtZSBhcyBvdGhlciBgbG9kYXNoYCBtZXRob2RzLiAqL1xudmFyIG5hdGl2ZU1heCA9IE1hdGgubWF4O1xuXG4vKipcbiAqIENyZWF0ZXMgYSBmdW5jdGlvbiB0aGF0IGludm9rZXMgYGZ1bmNgIHdpdGggdGhlIGB0aGlzYCBiaW5kaW5nIG9mIHRoZVxuICogY3JlYXRlZCBmdW5jdGlvbiBhbmQgYXJndW1lbnRzIGZyb20gYHN0YXJ0YCBhbmQgYmV5b25kIHByb3ZpZGVkIGFzXG4gKiBhbiBhcnJheS5cbiAqXG4gKiAqKk5vdGU6KiogVGhpcyBtZXRob2QgaXMgYmFzZWQgb24gdGhlXG4gKiBbcmVzdCBwYXJhbWV0ZXJdKGh0dHBzOi8vbWRuLmlvL3Jlc3RfcGFyYW1ldGVycykuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBmdW5jdGlvbiB0byBhcHBseSBhIHJlc3QgcGFyYW1ldGVyIHRvLlxuICogQHBhcmFtIHtudW1iZXJ9IFtzdGFydD1mdW5jLmxlbmd0aC0xXSBUaGUgc3RhcnQgcG9zaXRpb24gb2YgdGhlIHJlc3QgcGFyYW1ldGVyLlxuICogQHJldHVybnMge0Z1bmN0aW9ufSBSZXR1cm5zIHRoZSBuZXcgZnVuY3Rpb24uXG4gKiBAZXhhbXBsZVxuICpcbiAqIHZhciBzYXkgPSBfLnJlc3QoZnVuY3Rpb24od2hhdCwgbmFtZXMpIHtcbiAqICAgcmV0dXJuIHdoYXQgKyAnICcgKyBfLmluaXRpYWwobmFtZXMpLmpvaW4oJywgJykgK1xuICogICAgIChfLnNpemUobmFtZXMpID4gMSA/ICcsICYgJyA6ICcnKSArIF8ubGFzdChuYW1lcyk7XG4gKiB9KTtcbiAqXG4gKiBzYXkoJ2hlbGxvJywgJ2ZyZWQnLCAnYmFybmV5JywgJ3BlYmJsZXMnKTtcbiAqIC8vID0+ICdoZWxsbyBmcmVkLCBiYXJuZXksICYgcGViYmxlcydcbiAqL1xuZnVuY3Rpb24gcmVzdChmdW5jLCBzdGFydCkge1xuICBpZiAodHlwZW9mIGZ1bmMgIT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoRlVOQ19FUlJPUl9URVhUKTtcbiAgfVxuICBzdGFydCA9IG5hdGl2ZU1heChzdGFydCA9PT0gdW5kZWZpbmVkID8gKGZ1bmMubGVuZ3RoIC0gMSkgOiB0b0ludGVnZXIoc3RhcnQpLCAwKTtcbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciBhcmdzID0gYXJndW1lbnRzLFxuICAgICAgICBpbmRleCA9IC0xLFxuICAgICAgICBsZW5ndGggPSBuYXRpdmVNYXgoYXJncy5sZW5ndGggLSBzdGFydCwgMCksXG4gICAgICAgIGFycmF5ID0gQXJyYXkobGVuZ3RoKTtcblxuICAgIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgICBhcnJheVtpbmRleF0gPSBhcmdzW3N0YXJ0ICsgaW5kZXhdO1xuICAgIH1cbiAgICBzd2l0Y2ggKHN0YXJ0KSB7XG4gICAgICBjYXNlIDA6IHJldHVybiBmdW5jLmNhbGwodGhpcywgYXJyYXkpO1xuICAgICAgY2FzZSAxOiByZXR1cm4gZnVuYy5jYWxsKHRoaXMsIGFyZ3NbMF0sIGFycmF5KTtcbiAgICAgIGNhc2UgMjogcmV0dXJuIGZ1bmMuY2FsbCh0aGlzLCBhcmdzWzBdLCBhcmdzWzFdLCBhcnJheSk7XG4gICAgfVxuICAgIHZhciBvdGhlckFyZ3MgPSBBcnJheShzdGFydCArIDEpO1xuICAgIGluZGV4ID0gLTE7XG4gICAgd2hpbGUgKCsraW5kZXggPCBzdGFydCkge1xuICAgICAgb3RoZXJBcmdzW2luZGV4XSA9IGFyZ3NbaW5kZXhdO1xuICAgIH1cbiAgICBvdGhlckFyZ3Nbc3RhcnRdID0gYXJyYXk7XG4gICAgcmV0dXJuIGFwcGx5KGZ1bmMsIHRoaXMsIG90aGVyQXJncyk7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gcmVzdDtcbiIsInZhciB0b051bWJlciA9IHJlcXVpcmUoJy4vdG9OdW1iZXInKTtcblxuLyoqIFVzZWQgYXMgcmVmZXJlbmNlcyBmb3IgdmFyaW91cyBgTnVtYmVyYCBjb25zdGFudHMuICovXG52YXIgSU5GSU5JVFkgPSAxIC8gMCxcbiAgICBNQVhfSU5URUdFUiA9IDEuNzk3NjkzMTM0ODYyMzE1N2UrMzA4O1xuXG4vKipcbiAqIENvbnZlcnRzIGB2YWx1ZWAgdG8gYW4gaW50ZWdlci5cbiAqXG4gKiAqKk5vdGU6KiogVGhpcyBmdW5jdGlvbiBpcyBsb29zZWx5IGJhc2VkIG9uXG4gKiBbYFRvSW50ZWdlcmBdKGh0dHA6Ly93d3cuZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy10b2ludGVnZXIpLlxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgNC4wLjBcbiAqIEBjYXRlZ29yeSBMYW5nXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjb252ZXJ0LlxuICogQHJldHVybnMge251bWJlcn0gUmV0dXJucyB0aGUgY29udmVydGVkIGludGVnZXIuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8udG9JbnRlZ2VyKDMpO1xuICogLy8gPT4gM1xuICpcbiAqIF8udG9JbnRlZ2VyKE51bWJlci5NSU5fVkFMVUUpO1xuICogLy8gPT4gMFxuICpcbiAqIF8udG9JbnRlZ2VyKEluZmluaXR5KTtcbiAqIC8vID0+IDEuNzk3NjkzMTM0ODYyMzE1N2UrMzA4XG4gKlxuICogXy50b0ludGVnZXIoJzMnKTtcbiAqIC8vID0+IDNcbiAqL1xuZnVuY3Rpb24gdG9JbnRlZ2VyKHZhbHVlKSB7XG4gIGlmICghdmFsdWUpIHtcbiAgICByZXR1cm4gdmFsdWUgPT09IDAgPyB2YWx1ZSA6IDA7XG4gIH1cbiAgdmFsdWUgPSB0b051bWJlcih2YWx1ZSk7XG4gIGlmICh2YWx1ZSA9PT0gSU5GSU5JVFkgfHwgdmFsdWUgPT09IC1JTkZJTklUWSkge1xuICAgIHZhciBzaWduID0gKHZhbHVlIDwgMCA/IC0xIDogMSk7XG4gICAgcmV0dXJuIHNpZ24gKiBNQVhfSU5URUdFUjtcbiAgfVxuICB2YXIgcmVtYWluZGVyID0gdmFsdWUgJSAxO1xuICByZXR1cm4gdmFsdWUgPT09IHZhbHVlID8gKHJlbWFpbmRlciA/IHZhbHVlIC0gcmVtYWluZGVyIDogdmFsdWUpIDogMDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB0b0ludGVnZXI7XG4iLCJ2YXIgaXNGdW5jdGlvbiA9IHJlcXVpcmUoJy4vaXNGdW5jdGlvbicpLFxuICAgIGlzT2JqZWN0ID0gcmVxdWlyZSgnLi9pc09iamVjdCcpLFxuICAgIGlzU3ltYm9sID0gcmVxdWlyZSgnLi9pc1N5bWJvbCcpO1xuXG4vKiogVXNlZCBhcyByZWZlcmVuY2VzIGZvciB2YXJpb3VzIGBOdW1iZXJgIGNvbnN0YW50cy4gKi9cbnZhciBOQU4gPSAwIC8gMDtcblxuLyoqIFVzZWQgdG8gbWF0Y2ggbGVhZGluZyBhbmQgdHJhaWxpbmcgd2hpdGVzcGFjZS4gKi9cbnZhciByZVRyaW0gPSAvXlxccyt8XFxzKyQvZztcblxuLyoqIFVzZWQgdG8gZGV0ZWN0IGJhZCBzaWduZWQgaGV4YWRlY2ltYWwgc3RyaW5nIHZhbHVlcy4gKi9cbnZhciByZUlzQmFkSGV4ID0gL15bLStdMHhbMC05YS1mXSskL2k7XG5cbi8qKiBVc2VkIHRvIGRldGVjdCBiaW5hcnkgc3RyaW5nIHZhbHVlcy4gKi9cbnZhciByZUlzQmluYXJ5ID0gL14wYlswMV0rJC9pO1xuXG4vKiogVXNlZCB0byBkZXRlY3Qgb2N0YWwgc3RyaW5nIHZhbHVlcy4gKi9cbnZhciByZUlzT2N0YWwgPSAvXjBvWzAtN10rJC9pO1xuXG4vKiogQnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMgd2l0aG91dCBhIGRlcGVuZGVuY3kgb24gYHJvb3RgLiAqL1xudmFyIGZyZWVQYXJzZUludCA9IHBhcnNlSW50O1xuXG4vKipcbiAqIENvbnZlcnRzIGB2YWx1ZWAgdG8gYSBudW1iZXIuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIHByb2Nlc3MuXG4gKiBAcmV0dXJucyB7bnVtYmVyfSBSZXR1cm5zIHRoZSBudW1iZXIuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8udG9OdW1iZXIoMyk7XG4gKiAvLyA9PiAzXG4gKlxuICogXy50b051bWJlcihOdW1iZXIuTUlOX1ZBTFVFKTtcbiAqIC8vID0+IDVlLTMyNFxuICpcbiAqIF8udG9OdW1iZXIoSW5maW5pdHkpO1xuICogLy8gPT4gSW5maW5pdHlcbiAqXG4gKiBfLnRvTnVtYmVyKCczJyk7XG4gKiAvLyA9PiAzXG4gKi9cbmZ1bmN0aW9uIHRvTnVtYmVyKHZhbHVlKSB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT0gJ251bWJlcicpIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbiAgaWYgKGlzU3ltYm9sKHZhbHVlKSkge1xuICAgIHJldHVybiBOQU47XG4gIH1cbiAgaWYgKGlzT2JqZWN0KHZhbHVlKSkge1xuICAgIHZhciBvdGhlciA9IGlzRnVuY3Rpb24odmFsdWUudmFsdWVPZikgPyB2YWx1ZS52YWx1ZU9mKCkgOiB2YWx1ZTtcbiAgICB2YWx1ZSA9IGlzT2JqZWN0KG90aGVyKSA/IChvdGhlciArICcnKSA6IG90aGVyO1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgIT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gdmFsdWUgPT09IDAgPyB2YWx1ZSA6ICt2YWx1ZTtcbiAgfVxuICB2YWx1ZSA9IHZhbHVlLnJlcGxhY2UocmVUcmltLCAnJyk7XG4gIHZhciBpc0JpbmFyeSA9IHJlSXNCaW5hcnkudGVzdCh2YWx1ZSk7XG4gIHJldHVybiAoaXNCaW5hcnkgfHwgcmVJc09jdGFsLnRlc3QodmFsdWUpKVxuICAgID8gZnJlZVBhcnNlSW50KHZhbHVlLnNsaWNlKDIpLCBpc0JpbmFyeSA/IDIgOiA4KVxuICAgIDogKHJlSXNCYWRIZXgudGVzdCh2YWx1ZSkgPyBOQU4gOiArdmFsdWUpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHRvTnVtYmVyO1xuIiwidmFyIGJhc2VEaWZmZXJlbmNlID0gcmVxdWlyZSgnLi9fYmFzZURpZmZlcmVuY2UnKSxcbiAgICBpc0FycmF5TGlrZU9iamVjdCA9IHJlcXVpcmUoJy4vaXNBcnJheUxpa2VPYmplY3QnKSxcbiAgICByZXN0ID0gcmVxdWlyZSgnLi9yZXN0Jyk7XG5cbi8qKlxuICogQ3JlYXRlcyBhbiBhcnJheSBleGNsdWRpbmcgYWxsIGdpdmVuIHZhbHVlcyB1c2luZ1xuICogW2BTYW1lVmFsdWVaZXJvYF0oaHR0cDovL2VjbWEtaW50ZXJuYXRpb25hbC5vcmcvZWNtYS0yNjIvNi4wLyNzZWMtc2FtZXZhbHVlemVybylcbiAqIGZvciBlcXVhbGl0eSBjb21wYXJpc29ucy5cbiAqXG4gKiBAc3RhdGljXG4gKiBAbWVtYmVyT2YgX1xuICogQHNpbmNlIDAuMS4wXG4gKiBAY2F0ZWdvcnkgQXJyYXlcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBmaWx0ZXIuXG4gKiBAcGFyYW0gey4uLip9IFt2YWx1ZXNdIFRoZSB2YWx1ZXMgdG8gZXhjbHVkZS5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgbmV3IGFycmF5IG9mIGZpbHRlcmVkIHZhbHVlcy5cbiAqIEBleGFtcGxlXG4gKlxuICogXy53aXRob3V0KFsxLCAyLCAxLCAzXSwgMSwgMik7XG4gKiAvLyA9PiBbM11cbiAqL1xudmFyIHdpdGhvdXQgPSByZXN0KGZ1bmN0aW9uKGFycmF5LCB2YWx1ZXMpIHtcbiAgcmV0dXJuIGlzQXJyYXlMaWtlT2JqZWN0KGFycmF5KVxuICAgID8gYmFzZURpZmZlcmVuY2UoYXJyYXksIHZhbHVlcylcbiAgICA6IFtdO1xufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gd2l0aG91dDtcbiIsInZhciBhcnJheUZpbHRlciA9IHJlcXVpcmUoJy4vX2FycmF5RmlsdGVyJyksXG4gICAgYmFzZVhvciA9IHJlcXVpcmUoJy4vX2Jhc2VYb3InKSxcbiAgICBpc0FycmF5TGlrZU9iamVjdCA9IHJlcXVpcmUoJy4vaXNBcnJheUxpa2VPYmplY3QnKSxcbiAgICByZXN0ID0gcmVxdWlyZSgnLi9yZXN0Jyk7XG5cbi8qKlxuICogQ3JlYXRlcyBhbiBhcnJheSBvZiB1bmlxdWUgdmFsdWVzIHRoYXQgaXMgdGhlXG4gKiBbc3ltbWV0cmljIGRpZmZlcmVuY2VdKGh0dHBzOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL1N5bW1ldHJpY19kaWZmZXJlbmNlKVxuICogb2YgdGhlIGdpdmVuIGFycmF5cy4gVGhlIG9yZGVyIG9mIHJlc3VsdCB2YWx1ZXMgaXMgZGV0ZXJtaW5lZCBieSB0aGUgb3JkZXJcbiAqIHRoZXkgb2NjdXIgaW4gdGhlIGFycmF5cy5cbiAqXG4gKiBAc3RhdGljXG4gKiBAbWVtYmVyT2YgX1xuICogQHNpbmNlIDIuNC4wXG4gKiBAY2F0ZWdvcnkgQXJyYXlcbiAqIEBwYXJhbSB7Li4uQXJyYXl9IFthcnJheXNdIFRoZSBhcnJheXMgdG8gaW5zcGVjdC5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgbmV3IGFycmF5IG9mIHZhbHVlcy5cbiAqIEBleGFtcGxlXG4gKlxuICogXy54b3IoWzIsIDFdLCBbNCwgMl0pO1xuICogLy8gPT4gWzEsIDRdXG4gKi9cbnZhciB4b3IgPSByZXN0KGZ1bmN0aW9uKGFycmF5cykge1xuICByZXR1cm4gYmFzZVhvcihhcnJheUZpbHRlcihhcnJheXMsIGlzQXJyYXlMaWtlT2JqZWN0KSk7XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSB4b3I7XG4iLCIvKipcbiAqIENvcHlyaWdodCAyMDEzLTIwMTUsIEZhY2Vib29rLCBJbmMuXG4gKiBBbGwgcmlnaHRzIHJlc2VydmVkLlxuICpcbiAqIFRoaXMgc291cmNlIGNvZGUgaXMgbGljZW5zZWQgdW5kZXIgdGhlIEJTRC1zdHlsZSBsaWNlbnNlIGZvdW5kIGluIHRoZVxuICogTElDRU5TRSBmaWxlIGluIHRoZSByb290IGRpcmVjdG9yeSBvZiB0aGlzIHNvdXJjZSB0cmVlLiBBbiBhZGRpdGlvbmFsIGdyYW50XG4gKiBvZiBwYXRlbnQgcmlnaHRzIGNhbiBiZSBmb3VuZCBpbiB0aGUgUEFURU5UUyBmaWxlIGluIHRoZSBzYW1lIGRpcmVjdG9yeS5cbiAqL1xuXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICogVXNlIGludmFyaWFudCgpIHRvIGFzc2VydCBzdGF0ZSB3aGljaCB5b3VyIHByb2dyYW0gYXNzdW1lcyB0byBiZSB0cnVlLlxuICpcbiAqIFByb3ZpZGUgc3ByaW50Zi1zdHlsZSBmb3JtYXQgKG9ubHkgJXMgaXMgc3VwcG9ydGVkKSBhbmQgYXJndW1lbnRzXG4gKiB0byBwcm92aWRlIGluZm9ybWF0aW9uIGFib3V0IHdoYXQgYnJva2UgYW5kIHdoYXQgeW91IHdlcmVcbiAqIGV4cGVjdGluZy5cbiAqXG4gKiBUaGUgaW52YXJpYW50IG1lc3NhZ2Ugd2lsbCBiZSBzdHJpcHBlZCBpbiBwcm9kdWN0aW9uLCBidXQgdGhlIGludmFyaWFudFxuICogd2lsbCByZW1haW4gdG8gZW5zdXJlIGxvZ2ljIGRvZXMgbm90IGRpZmZlciBpbiBwcm9kdWN0aW9uLlxuICovXG5cbnZhciBpbnZhcmlhbnQgPSBmdW5jdGlvbihjb25kaXRpb24sIGZvcm1hdCwgYSwgYiwgYywgZCwgZSwgZikge1xuICBpZiAocHJvY2Vzcy5lbnYuTk9ERV9FTlYgIT09ICdwcm9kdWN0aW9uJykge1xuICAgIGlmIChmb3JtYXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdpbnZhcmlhbnQgcmVxdWlyZXMgYW4gZXJyb3IgbWVzc2FnZSBhcmd1bWVudCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmICghY29uZGl0aW9uKSB7XG4gICAgdmFyIGVycm9yO1xuICAgIGlmIChmb3JtYXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZXJyb3IgPSBuZXcgRXJyb3IoXG4gICAgICAgICdNaW5pZmllZCBleGNlcHRpb24gb2NjdXJyZWQ7IHVzZSB0aGUgbm9uLW1pbmlmaWVkIGRldiBlbnZpcm9ubWVudCAnICtcbiAgICAgICAgJ2ZvciB0aGUgZnVsbCBlcnJvciBtZXNzYWdlIGFuZCBhZGRpdGlvbmFsIGhlbHBmdWwgd2FybmluZ3MuJ1xuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGFyZ3MgPSBbYSwgYiwgYywgZCwgZSwgZl07XG4gICAgICB2YXIgYXJnSW5kZXggPSAwO1xuICAgICAgZXJyb3IgPSBuZXcgRXJyb3IoXG4gICAgICAgIGZvcm1hdC5yZXBsYWNlKC8lcy9nLCBmdW5jdGlvbigpIHsgcmV0dXJuIGFyZ3NbYXJnSW5kZXgrK107IH0pXG4gICAgICApO1xuICAgICAgZXJyb3IubmFtZSA9ICdJbnZhcmlhbnQgVmlvbGF0aW9uJztcbiAgICB9XG5cbiAgICBlcnJvci5mcmFtZXNUb1BvcCA9IDE7IC8vIHdlIGRvbid0IGNhcmUgYWJvdXQgaW52YXJpYW50J3Mgb3duIGZyYW1lXG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn07XG5cbm1vZHVsZS5leHBvcnRzID0gaW52YXJpYW50O1xuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHNldFRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgaWYgKGN1cnJlbnRRdWV1ZSkge1xuICAgICAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZHJhaW5RdWV1ZSwgMCk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxudmFyIF9sb2Rhc2hNZW1vaXplID0gcmVxdWlyZSgnbG9kYXNoL21lbW9pemUnKTtcblxudmFyIF9sb2Rhc2hNZW1vaXplMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaE1lbW9pemUpO1xuXG52YXIgaXNGaXJlZm94ID0gX2xvZGFzaE1lbW9pemUyWydkZWZhdWx0J10oZnVuY3Rpb24gKCkge1xuICByZXR1cm4gKC9maXJlZm94L2kudGVzdChuYXZpZ2F0b3IudXNlckFnZW50KVxuICApO1xufSk7XG5cbmV4cG9ydHMuaXNGaXJlZm94ID0gaXNGaXJlZm94O1xudmFyIGlzU2FmYXJpID0gX2xvZGFzaE1lbW9pemUyWydkZWZhdWx0J10oZnVuY3Rpb24gKCkge1xuICByZXR1cm4gQm9vbGVhbih3aW5kb3cuc2FmYXJpKTtcbn0pO1xuZXhwb3J0cy5pc1NhZmFyaSA9IGlzU2FmYXJpOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH1cblxudmFyIF9sb2Rhc2hVbmlvbiA9IHJlcXVpcmUoJ2xvZGFzaC91bmlvbicpO1xuXG52YXIgX2xvZGFzaFVuaW9uMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaFVuaW9uKTtcblxudmFyIF9sb2Rhc2hXaXRob3V0ID0gcmVxdWlyZSgnbG9kYXNoL3dpdGhvdXQnKTtcblxudmFyIF9sb2Rhc2hXaXRob3V0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaFdpdGhvdXQpO1xuXG52YXIgRW50ZXJMZWF2ZUNvdW50ZXIgPSAoZnVuY3Rpb24gKCkge1xuICBmdW5jdGlvbiBFbnRlckxlYXZlQ291bnRlcigpIHtcbiAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgRW50ZXJMZWF2ZUNvdW50ZXIpO1xuXG4gICAgdGhpcy5lbnRlcmVkID0gW107XG4gIH1cblxuICBFbnRlckxlYXZlQ291bnRlci5wcm90b3R5cGUuZW50ZXIgPSBmdW5jdGlvbiBlbnRlcihlbnRlcmluZ05vZGUpIHtcbiAgICB2YXIgcHJldmlvdXNMZW5ndGggPSB0aGlzLmVudGVyZWQubGVuZ3RoO1xuXG4gICAgdGhpcy5lbnRlcmVkID0gX2xvZGFzaFVuaW9uMlsnZGVmYXVsdCddKHRoaXMuZW50ZXJlZC5maWx0ZXIoZnVuY3Rpb24gKG5vZGUpIHtcbiAgICAgIHJldHVybiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY29udGFpbnMobm9kZSkgJiYgKCFub2RlLmNvbnRhaW5zIHx8IG5vZGUuY29udGFpbnMoZW50ZXJpbmdOb2RlKSk7XG4gICAgfSksIFtlbnRlcmluZ05vZGVdKTtcblxuICAgIHJldHVybiBwcmV2aW91c0xlbmd0aCA9PT0gMCAmJiB0aGlzLmVudGVyZWQubGVuZ3RoID4gMDtcbiAgfTtcblxuICBFbnRlckxlYXZlQ291bnRlci5wcm90b3R5cGUubGVhdmUgPSBmdW5jdGlvbiBsZWF2ZShsZWF2aW5nTm9kZSkge1xuICAgIHZhciBwcmV2aW91c0xlbmd0aCA9IHRoaXMuZW50ZXJlZC5sZW5ndGg7XG5cbiAgICB0aGlzLmVudGVyZWQgPSBfbG9kYXNoV2l0aG91dDJbJ2RlZmF1bHQnXSh0aGlzLmVudGVyZWQuZmlsdGVyKGZ1bmN0aW9uIChub2RlKSB7XG4gICAgICByZXR1cm4gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNvbnRhaW5zKG5vZGUpO1xuICAgIH0pLCBsZWF2aW5nTm9kZSk7XG5cbiAgICByZXR1cm4gcHJldmlvdXNMZW5ndGggPiAwICYmIHRoaXMuZW50ZXJlZC5sZW5ndGggPT09IDA7XG4gIH07XG5cbiAgRW50ZXJMZWF2ZUNvdW50ZXIucHJvdG90eXBlLnJlc2V0ID0gZnVuY3Rpb24gcmVzZXQoKSB7XG4gICAgdGhpcy5lbnRlcmVkID0gW107XG4gIH07XG5cbiAgcmV0dXJuIEVudGVyTGVhdmVDb3VudGVyO1xufSkoKTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gRW50ZXJMZWF2ZUNvdW50ZXI7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKG9iaikgeyBpZiAob2JqICYmIG9iai5fX2VzTW9kdWxlKSB7IHJldHVybiBvYmo7IH0gZWxzZSB7IHZhciBuZXdPYmogPSB7fTsgaWYgKG9iaiAhPSBudWxsKSB7IGZvciAodmFyIGtleSBpbiBvYmopIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIG5ld09ialtrZXldID0gb2JqW2tleV07IH0gfSBuZXdPYmpbJ2RlZmF1bHQnXSA9IG9iajsgcmV0dXJuIG5ld09iajsgfSB9XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbnZhciBfbG9kYXNoRGVmYXVsdHMgPSByZXF1aXJlKCdsb2Rhc2gvZGVmYXVsdHMnKTtcblxudmFyIF9sb2Rhc2hEZWZhdWx0czIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hEZWZhdWx0cyk7XG5cbnZhciBfc2hhbGxvd0VxdWFsID0gcmVxdWlyZSgnLi9zaGFsbG93RXF1YWwnKTtcblxudmFyIF9zaGFsbG93RXF1YWwyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfc2hhbGxvd0VxdWFsKTtcblxudmFyIF9FbnRlckxlYXZlQ291bnRlciA9IHJlcXVpcmUoJy4vRW50ZXJMZWF2ZUNvdW50ZXInKTtcblxudmFyIF9FbnRlckxlYXZlQ291bnRlcjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9FbnRlckxlYXZlQ291bnRlcik7XG5cbnZhciBfQnJvd3NlckRldGVjdG9yID0gcmVxdWlyZSgnLi9Ccm93c2VyRGV0ZWN0b3InKTtcblxudmFyIF9PZmZzZXRVdGlscyA9IHJlcXVpcmUoJy4vT2Zmc2V0VXRpbHMnKTtcblxudmFyIF9OYXRpdmVEcmFnU291cmNlcyA9IHJlcXVpcmUoJy4vTmF0aXZlRHJhZ1NvdXJjZXMnKTtcblxudmFyIF9OYXRpdmVUeXBlcyA9IHJlcXVpcmUoJy4vTmF0aXZlVHlwZXMnKTtcblxudmFyIE5hdGl2ZVR5cGVzID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX05hdGl2ZVR5cGVzKTtcblxudmFyIEhUTUw1QmFja2VuZCA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIEhUTUw1QmFja2VuZChtYW5hZ2VyKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIEhUTUw1QmFja2VuZCk7XG5cbiAgICB0aGlzLmFjdGlvbnMgPSBtYW5hZ2VyLmdldEFjdGlvbnMoKTtcbiAgICB0aGlzLm1vbml0b3IgPSBtYW5hZ2VyLmdldE1vbml0b3IoKTtcbiAgICB0aGlzLnJlZ2lzdHJ5ID0gbWFuYWdlci5nZXRSZWdpc3RyeSgpO1xuXG4gICAgdGhpcy5zb3VyY2VQcmV2aWV3Tm9kZXMgPSB7fTtcbiAgICB0aGlzLnNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucyA9IHt9O1xuICAgIHRoaXMuc291cmNlTm9kZXMgPSB7fTtcbiAgICB0aGlzLnNvdXJjZU5vZGVPcHRpb25zID0ge307XG4gICAgdGhpcy5lbnRlckxlYXZlQ291bnRlciA9IG5ldyBfRW50ZXJMZWF2ZUNvdW50ZXIyWydkZWZhdWx0J10oKTtcblxuICAgIHRoaXMuZ2V0U291cmNlQ2xpZW50T2Zmc2V0ID0gdGhpcy5nZXRTb3VyY2VDbGllbnRPZmZzZXQuYmluZCh0aGlzKTtcbiAgICB0aGlzLmhhbmRsZVRvcERyYWdTdGFydCA9IHRoaXMuaGFuZGxlVG9wRHJhZ1N0YXJ0LmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcmFnU3RhcnRDYXB0dXJlID0gdGhpcy5oYW5kbGVUb3BEcmFnU3RhcnRDYXB0dXJlLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcmFnRW5kQ2FwdHVyZSA9IHRoaXMuaGFuZGxlVG9wRHJhZ0VuZENhcHR1cmUuYmluZCh0aGlzKTtcbiAgICB0aGlzLmhhbmRsZVRvcERyYWdFbnRlciA9IHRoaXMuaGFuZGxlVG9wRHJhZ0VudGVyLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcmFnRW50ZXJDYXB0dXJlID0gdGhpcy5oYW5kbGVUb3BEcmFnRW50ZXJDYXB0dXJlLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcmFnTGVhdmVDYXB0dXJlID0gdGhpcy5oYW5kbGVUb3BEcmFnTGVhdmVDYXB0dXJlLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcmFnT3ZlciA9IHRoaXMuaGFuZGxlVG9wRHJhZ092ZXIuYmluZCh0aGlzKTtcbiAgICB0aGlzLmhhbmRsZVRvcERyYWdPdmVyQ2FwdHVyZSA9IHRoaXMuaGFuZGxlVG9wRHJhZ092ZXJDYXB0dXJlLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcm9wID0gdGhpcy5oYW5kbGVUb3BEcm9wLmJpbmQodGhpcyk7XG4gICAgdGhpcy5oYW5kbGVUb3BEcm9wQ2FwdHVyZSA9IHRoaXMuaGFuZGxlVG9wRHJvcENhcHR1cmUuYmluZCh0aGlzKTtcbiAgICB0aGlzLmhhbmRsZVNlbGVjdFN0YXJ0ID0gdGhpcy5oYW5kbGVTZWxlY3RTdGFydC5iaW5kKHRoaXMpO1xuICAgIHRoaXMuZW5kRHJhZ0lmU291cmNlV2FzUmVtb3ZlZEZyb21ET00gPSB0aGlzLmVuZERyYWdJZlNvdXJjZVdhc1JlbW92ZWRGcm9tRE9NLmJpbmQodGhpcyk7XG4gICAgdGhpcy5lbmREcmFnTmF0aXZlSXRlbSA9IHRoaXMuZW5kRHJhZ05hdGl2ZUl0ZW0uYmluZCh0aGlzKTtcbiAgfVxuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuc2V0dXAgPSBmdW5jdGlvbiBzZXR1cCgpIHtcbiAgICBpZiAodHlwZW9mIHdpbmRvdyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jb25zdHJ1Y3Rvci5pc1NldFVwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBoYXZlIHR3byBIVE1MNSBiYWNrZW5kcyBhdCB0aGUgc2FtZSB0aW1lLicpO1xuICAgIH1cbiAgICB0aGlzLmNvbnN0cnVjdG9yLmlzU2V0VXAgPSB0cnVlO1xuICAgIHRoaXMuYWRkRXZlbnRMaXN0ZW5lcnMod2luZG93KTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLnRlYXJkb3duID0gZnVuY3Rpb24gdGVhcmRvd24oKSB7XG4gICAgaWYgKHR5cGVvZiB3aW5kb3cgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5jb25zdHJ1Y3Rvci5pc1NldFVwID0gZmFsc2U7XG4gICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVycyh3aW5kb3cpO1xuICAgIHRoaXMuY2xlYXJDdXJyZW50RHJhZ1NvdXJjZU5vZGUoKTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmFkZEV2ZW50TGlzdGVuZXJzID0gZnVuY3Rpb24gYWRkRXZlbnRMaXN0ZW5lcnModGFyZ2V0KSB7XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdzdGFydCcsIHRoaXMuaGFuZGxlVG9wRHJhZ1N0YXJ0KTtcbiAgICB0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgdGhpcy5oYW5kbGVUb3BEcmFnU3RhcnRDYXB0dXJlLCB0cnVlKTtcbiAgICB0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ2VuZCcsIHRoaXMuaGFuZGxlVG9wRHJhZ0VuZENhcHR1cmUsIHRydWUpO1xuICAgIHRhcmdldC5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW50ZXInLCB0aGlzLmhhbmRsZVRvcERyYWdFbnRlcik7XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdlbnRlcicsIHRoaXMuaGFuZGxlVG9wRHJhZ0VudGVyQ2FwdHVyZSwgdHJ1ZSk7XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdsZWF2ZScsIHRoaXMuaGFuZGxlVG9wRHJhZ0xlYXZlQ2FwdHVyZSwgdHJ1ZSk7XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgdGhpcy5oYW5kbGVUb3BEcmFnT3Zlcik7XG4gICAgdGFyZ2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJywgdGhpcy5oYW5kbGVUb3BEcmFnT3ZlckNhcHR1cmUsIHRydWUpO1xuICAgIHRhcmdldC5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgdGhpcy5oYW5kbGVUb3BEcm9wKTtcbiAgICB0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsIHRoaXMuaGFuZGxlVG9wRHJvcENhcHR1cmUsIHRydWUpO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUucmVtb3ZlRXZlbnRMaXN0ZW5lcnMgPSBmdW5jdGlvbiByZW1vdmVFdmVudExpc3RlbmVycyh0YXJnZXQpIHtcbiAgICB0YXJnZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJhZ3N0YXJ0JywgdGhpcy5oYW5kbGVUb3BEcmFnU3RhcnQpO1xuICAgIHRhcmdldC5yZW1vdmVFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCB0aGlzLmhhbmRsZVRvcERyYWdTdGFydENhcHR1cmUsIHRydWUpO1xuICAgIHRhcmdldC5yZW1vdmVFdmVudExpc3RlbmVyKCdkcmFnZW5kJywgdGhpcy5oYW5kbGVUb3BEcmFnRW5kQ2FwdHVyZSwgdHJ1ZSk7XG4gICAgdGFyZ2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2RyYWdlbnRlcicsIHRoaXMuaGFuZGxlVG9wRHJhZ0VudGVyKTtcbiAgICB0YXJnZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJhZ2VudGVyJywgdGhpcy5oYW5kbGVUb3BEcmFnRW50ZXJDYXB0dXJlLCB0cnVlKTtcbiAgICB0YXJnZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJhZ2xlYXZlJywgdGhpcy5oYW5kbGVUb3BEcmFnTGVhdmVDYXB0dXJlLCB0cnVlKTtcbiAgICB0YXJnZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCB0aGlzLmhhbmRsZVRvcERyYWdPdmVyKTtcbiAgICB0YXJnZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCB0aGlzLmhhbmRsZVRvcERyYWdPdmVyQ2FwdHVyZSwgdHJ1ZSk7XG4gICAgdGFyZ2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Ryb3AnLCB0aGlzLmhhbmRsZVRvcERyb3ApO1xuICAgIHRhcmdldC5yZW1vdmVFdmVudExpc3RlbmVyKCdkcm9wJywgdGhpcy5oYW5kbGVUb3BEcm9wQ2FwdHVyZSwgdHJ1ZSk7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5jb25uZWN0RHJhZ1ByZXZpZXcgPSBmdW5jdGlvbiBjb25uZWN0RHJhZ1ByZXZpZXcoc291cmNlSWQsIG5vZGUsIG9wdGlvbnMpIHtcbiAgICB2YXIgX3RoaXMgPSB0aGlzO1xuXG4gICAgdGhpcy5zb3VyY2VQcmV2aWV3Tm9kZU9wdGlvbnNbc291cmNlSWRdID0gb3B0aW9ucztcbiAgICB0aGlzLnNvdXJjZVByZXZpZXdOb2Rlc1tzb3VyY2VJZF0gPSBub2RlO1xuXG4gICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgIGRlbGV0ZSBfdGhpcy5zb3VyY2VQcmV2aWV3Tm9kZXNbc291cmNlSWRdO1xuICAgICAgZGVsZXRlIF90aGlzLnNvdXJjZVByZXZpZXdOb2RlT3B0aW9uc1tzb3VyY2VJZF07XG4gICAgfTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmNvbm5lY3REcmFnU291cmNlID0gZnVuY3Rpb24gY29ubmVjdERyYWdTb3VyY2Uoc291cmNlSWQsIG5vZGUsIG9wdGlvbnMpIHtcbiAgICB2YXIgX3RoaXMyID0gdGhpcztcblxuICAgIHRoaXMuc291cmNlTm9kZXNbc291cmNlSWRdID0gbm9kZTtcbiAgICB0aGlzLnNvdXJjZU5vZGVPcHRpb25zW3NvdXJjZUlkXSA9IG9wdGlvbnM7XG5cbiAgICB2YXIgaGFuZGxlRHJhZ1N0YXJ0ID0gZnVuY3Rpb24gaGFuZGxlRHJhZ1N0YXJ0KGUpIHtcbiAgICAgIHJldHVybiBfdGhpczIuaGFuZGxlRHJhZ1N0YXJ0KGUsIHNvdXJjZUlkKTtcbiAgICB9O1xuICAgIHZhciBoYW5kbGVTZWxlY3RTdGFydCA9IGZ1bmN0aW9uIGhhbmRsZVNlbGVjdFN0YXJ0KGUpIHtcbiAgICAgIHJldHVybiBfdGhpczIuaGFuZGxlU2VsZWN0U3RhcnQoZSwgc291cmNlSWQpO1xuICAgIH07XG5cbiAgICBub2RlLnNldEF0dHJpYnV0ZSgnZHJhZ2dhYmxlJywgdHJ1ZSk7XG4gICAgbm9kZS5hZGRFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBoYW5kbGVEcmFnU3RhcnQpO1xuICAgIG5vZGUuYWRkRXZlbnRMaXN0ZW5lcignc2VsZWN0c3RhcnQnLCBoYW5kbGVTZWxlY3RTdGFydCk7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgZGVsZXRlIF90aGlzMi5zb3VyY2VOb2Rlc1tzb3VyY2VJZF07XG4gICAgICBkZWxldGUgX3RoaXMyLnNvdXJjZU5vZGVPcHRpb25zW3NvdXJjZUlkXTtcblxuICAgICAgbm9kZS5yZW1vdmVFdmVudExpc3RlbmVyKCdkcmFnc3RhcnQnLCBoYW5kbGVEcmFnU3RhcnQpO1xuICAgICAgbm9kZS5yZW1vdmVFdmVudExpc3RlbmVyKCdzZWxlY3RzdGFydCcsIGhhbmRsZVNlbGVjdFN0YXJ0KTtcbiAgICAgIG5vZGUuc2V0QXR0cmlidXRlKCdkcmFnZ2FibGUnLCBmYWxzZSk7XG4gICAgfTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmNvbm5lY3REcm9wVGFyZ2V0ID0gZnVuY3Rpb24gY29ubmVjdERyb3BUYXJnZXQodGFyZ2V0SWQsIG5vZGUpIHtcbiAgICB2YXIgX3RoaXMzID0gdGhpcztcblxuICAgIHZhciBoYW5kbGVEcmFnRW50ZXIgPSBmdW5jdGlvbiBoYW5kbGVEcmFnRW50ZXIoZSkge1xuICAgICAgcmV0dXJuIF90aGlzMy5oYW5kbGVEcmFnRW50ZXIoZSwgdGFyZ2V0SWQpO1xuICAgIH07XG4gICAgdmFyIGhhbmRsZURyYWdPdmVyID0gZnVuY3Rpb24gaGFuZGxlRHJhZ092ZXIoZSkge1xuICAgICAgcmV0dXJuIF90aGlzMy5oYW5kbGVEcmFnT3ZlcihlLCB0YXJnZXRJZCk7XG4gICAgfTtcbiAgICB2YXIgaGFuZGxlRHJvcCA9IGZ1bmN0aW9uIGhhbmRsZURyb3AoZSkge1xuICAgICAgcmV0dXJuIF90aGlzMy5oYW5kbGVEcm9wKGUsIHRhcmdldElkKTtcbiAgICB9O1xuXG4gICAgbm9kZS5hZGRFdmVudExpc3RlbmVyKCdkcmFnZW50ZXInLCBoYW5kbGVEcmFnRW50ZXIpO1xuICAgIG5vZGUuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLCBoYW5kbGVEcmFnT3Zlcik7XG4gICAgbm9kZS5hZGRFdmVudExpc3RlbmVyKCdkcm9wJywgaGFuZGxlRHJvcCk7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgbm9kZS5yZW1vdmVFdmVudExpc3RlbmVyKCdkcmFnZW50ZXInLCBoYW5kbGVEcmFnRW50ZXIpO1xuICAgICAgbm9kZS5yZW1vdmVFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsIGhhbmRsZURyYWdPdmVyKTtcbiAgICAgIG5vZGUucmVtb3ZlRXZlbnRMaXN0ZW5lcignZHJvcCcsIGhhbmRsZURyb3ApO1xuICAgIH07XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5nZXRDdXJyZW50U291cmNlTm9kZU9wdGlvbnMgPSBmdW5jdGlvbiBnZXRDdXJyZW50U291cmNlTm9kZU9wdGlvbnMoKSB7XG4gICAgdmFyIHNvdXJjZUlkID0gdGhpcy5tb25pdG9yLmdldFNvdXJjZUlkKCk7XG4gICAgdmFyIHNvdXJjZU5vZGVPcHRpb25zID0gdGhpcy5zb3VyY2VOb2RlT3B0aW9uc1tzb3VyY2VJZF07XG5cbiAgICByZXR1cm4gX2xvZGFzaERlZmF1bHRzMlsnZGVmYXVsdCddKHNvdXJjZU5vZGVPcHRpb25zIHx8IHt9LCB7XG4gICAgICBkcm9wRWZmZWN0OiAnbW92ZSdcbiAgICB9KTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmdldEN1cnJlbnREcm9wRWZmZWN0ID0gZnVuY3Rpb24gZ2V0Q3VycmVudERyb3BFZmZlY3QoKSB7XG4gICAgaWYgKHRoaXMuaXNEcmFnZ2luZ05hdGl2ZUl0ZW0oKSkge1xuICAgICAgLy8gSXQgbWFrZXMgbW9yZSBzZW5zZSB0byBkZWZhdWx0IHRvICdjb3B5JyBmb3IgbmF0aXZlIHJlc291cmNlc1xuICAgICAgcmV0dXJuICdjb3B5JztcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5nZXRDdXJyZW50U291cmNlTm9kZU9wdGlvbnMoKS5kcm9wRWZmZWN0O1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuZ2V0Q3VycmVudFNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucyA9IGZ1bmN0aW9uIGdldEN1cnJlbnRTb3VyY2VQcmV2aWV3Tm9kZU9wdGlvbnMoKSB7XG4gICAgdmFyIHNvdXJjZUlkID0gdGhpcy5tb25pdG9yLmdldFNvdXJjZUlkKCk7XG4gICAgdmFyIHNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucyA9IHRoaXMuc291cmNlUHJldmlld05vZGVPcHRpb25zW3NvdXJjZUlkXTtcblxuICAgIHJldHVybiBfbG9kYXNoRGVmYXVsdHMyWydkZWZhdWx0J10oc291cmNlUHJldmlld05vZGVPcHRpb25zIHx8IHt9LCB7XG4gICAgICBhbmNob3JYOiAwLjUsXG4gICAgICBhbmNob3JZOiAwLjUsXG4gICAgICBjYXB0dXJlRHJhZ2dpbmdTdGF0ZTogZmFsc2VcbiAgICB9KTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmdldFNvdXJjZUNsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldFNvdXJjZUNsaWVudE9mZnNldChzb3VyY2VJZCkge1xuICAgIHJldHVybiBfT2Zmc2V0VXRpbHMuZ2V0Tm9kZUNsaWVudE9mZnNldCh0aGlzLnNvdXJjZU5vZGVzW3NvdXJjZUlkXSk7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5pc0RyYWdnaW5nTmF0aXZlSXRlbSA9IGZ1bmN0aW9uIGlzRHJhZ2dpbmdOYXRpdmVJdGVtKCkge1xuICAgIHZhciBpdGVtVHlwZSA9IHRoaXMubW9uaXRvci5nZXRJdGVtVHlwZSgpO1xuICAgIHJldHVybiBPYmplY3Qua2V5cyhOYXRpdmVUeXBlcykuc29tZShmdW5jdGlvbiAoa2V5KSB7XG4gICAgICByZXR1cm4gTmF0aXZlVHlwZXNba2V5XSA9PT0gaXRlbVR5cGU7XG4gICAgfSk7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5iZWdpbkRyYWdOYXRpdmVJdGVtID0gZnVuY3Rpb24gYmVnaW5EcmFnTmF0aXZlSXRlbSh0eXBlKSB7XG4gICAgdGhpcy5jbGVhckN1cnJlbnREcmFnU291cmNlTm9kZSgpO1xuXG4gICAgdmFyIFNvdXJjZVR5cGUgPSBfTmF0aXZlRHJhZ1NvdXJjZXMuY3JlYXRlTmF0aXZlRHJhZ1NvdXJjZSh0eXBlKTtcbiAgICB0aGlzLmN1cnJlbnROYXRpdmVTb3VyY2UgPSBuZXcgU291cmNlVHlwZSgpO1xuICAgIHRoaXMuY3VycmVudE5hdGl2ZUhhbmRsZSA9IHRoaXMucmVnaXN0cnkuYWRkU291cmNlKHR5cGUsIHRoaXMuY3VycmVudE5hdGl2ZVNvdXJjZSk7XG4gICAgdGhpcy5hY3Rpb25zLmJlZ2luRHJhZyhbdGhpcy5jdXJyZW50TmF0aXZlSGFuZGxlXSk7XG5cbiAgICAvLyBPbiBGaXJlZm94LCBpZiBtb3VzZW1vdmUgZmlyZXMsIHRoZSBkcmFnIGlzIG92ZXIgYnV0IGJyb3dzZXIgZmFpbGVkIHRvIHRlbGwgdXMuXG4gICAgLy8gVGhpcyBpcyBub3QgdHJ1ZSBmb3Igb3RoZXIgYnJvd3NlcnMuXG4gICAgaWYgKF9Ccm93c2VyRGV0ZWN0b3IuaXNGaXJlZm94KCkpIHtcbiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCB0aGlzLmVuZERyYWdOYXRpdmVJdGVtLCB0cnVlKTtcbiAgICB9XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5lbmREcmFnTmF0aXZlSXRlbSA9IGZ1bmN0aW9uIGVuZERyYWdOYXRpdmVJdGVtKCkge1xuICAgIGlmICghdGhpcy5pc0RyYWdnaW5nTmF0aXZlSXRlbSgpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKF9Ccm93c2VyRGV0ZWN0b3IuaXNGaXJlZm94KCkpIHtcbiAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCB0aGlzLmVuZERyYWdOYXRpdmVJdGVtLCB0cnVlKTtcbiAgICB9XG5cbiAgICB0aGlzLmFjdGlvbnMuZW5kRHJhZygpO1xuICAgIHRoaXMucmVnaXN0cnkucmVtb3ZlU291cmNlKHRoaXMuY3VycmVudE5hdGl2ZUhhbmRsZSk7XG4gICAgdGhpcy5jdXJyZW50TmF0aXZlSGFuZGxlID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnROYXRpdmVTb3VyY2UgPSBudWxsO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuZW5kRHJhZ0lmU291cmNlV2FzUmVtb3ZlZEZyb21ET00gPSBmdW5jdGlvbiBlbmREcmFnSWZTb3VyY2VXYXNSZW1vdmVkRnJvbURPTSgpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuY3VycmVudERyYWdTb3VyY2VOb2RlO1xuICAgIGlmIChkb2N1bWVudC5ib2R5LmNvbnRhaW5zKG5vZGUpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY2xlYXJDdXJyZW50RHJhZ1NvdXJjZU5vZGUoKSkge1xuICAgICAgdGhpcy5hY3Rpb25zLmVuZERyYWcoKTtcbiAgICB9XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5zZXRDdXJyZW50RHJhZ1NvdXJjZU5vZGUgPSBmdW5jdGlvbiBzZXRDdXJyZW50RHJhZ1NvdXJjZU5vZGUobm9kZSkge1xuICAgIHRoaXMuY2xlYXJDdXJyZW50RHJhZ1NvdXJjZU5vZGUoKTtcbiAgICB0aGlzLmN1cnJlbnREcmFnU291cmNlTm9kZSA9IG5vZGU7XG4gICAgdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGVPZmZzZXQgPSBfT2Zmc2V0VXRpbHMuZ2V0Tm9kZUNsaWVudE9mZnNldChub2RlKTtcbiAgICB0aGlzLmN1cnJlbnREcmFnU291cmNlTm9kZU9mZnNldENoYW5nZWQgPSBmYWxzZTtcblxuICAgIC8vIFJlY2VpdmluZyBhIG1vdXNlIGV2ZW50IGluIHRoZSBtaWRkbGUgb2YgYSBkcmFnZ2luZyBvcGVyYXRpb25cbiAgICAvLyBtZWFucyBpdCBoYXMgZW5kZWQgYW5kIHRoZSBkcmFnIHNvdXJjZSBub2RlIGRpc2FwcGVhcmVkIGZyb20gRE9NLFxuICAgIC8vIHNvIHRoZSBicm93c2VyIGRpZG4ndCBkaXNwYXRjaCB0aGUgZHJhZ2VuZCBldmVudC5cbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgdGhpcy5lbmREcmFnSWZTb3VyY2VXYXNSZW1vdmVkRnJvbURPTSwgdHJ1ZSk7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5jbGVhckN1cnJlbnREcmFnU291cmNlTm9kZSA9IGZ1bmN0aW9uIGNsZWFyQ3VycmVudERyYWdTb3VyY2VOb2RlKCkge1xuICAgIGlmICh0aGlzLmN1cnJlbnREcmFnU291cmNlTm9kZSkge1xuICAgICAgdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGUgPSBudWxsO1xuICAgICAgdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGVPZmZzZXQgPSBudWxsO1xuICAgICAgdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGVPZmZzZXRDaGFuZ2VkID0gZmFsc2U7XG4gICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgdGhpcy5lbmREcmFnSWZTb3VyY2VXYXNSZW1vdmVkRnJvbURPTSwgdHJ1ZSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5jaGVja0lmQ3VycmVudERyYWdTb3VyY2VSZWN0Q2hhbmdlZCA9IGZ1bmN0aW9uIGNoZWNrSWZDdXJyZW50RHJhZ1NvdXJjZVJlY3RDaGFuZ2VkKCkge1xuICAgIHZhciBub2RlID0gdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGU7XG4gICAgaWYgKCFub2RlKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY3VycmVudERyYWdTb3VyY2VOb2RlT2Zmc2V0Q2hhbmdlZCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgdGhpcy5jdXJyZW50RHJhZ1NvdXJjZU5vZGVPZmZzZXRDaGFuZ2VkID0gIV9zaGFsbG93RXF1YWwyWydkZWZhdWx0J10oX09mZnNldFV0aWxzLmdldE5vZGVDbGllbnRPZmZzZXQobm9kZSksIHRoaXMuY3VycmVudERyYWdTb3VyY2VOb2RlT2Zmc2V0KTtcblxuICAgIHJldHVybiB0aGlzLmN1cnJlbnREcmFnU291cmNlTm9kZU9mZnNldENoYW5nZWQ7XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5oYW5kbGVUb3BEcmFnU3RhcnRDYXB0dXJlID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ1N0YXJ0Q2FwdHVyZSgpIHtcbiAgICB0aGlzLmNsZWFyQ3VycmVudERyYWdTb3VyY2VOb2RlKCk7XG4gICAgdGhpcy5kcmFnU3RhcnRTb3VyY2VJZHMgPSBbXTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmhhbmRsZURyYWdTdGFydCA9IGZ1bmN0aW9uIGhhbmRsZURyYWdTdGFydChlLCBzb3VyY2VJZCkge1xuICAgIHRoaXMuZHJhZ1N0YXJ0U291cmNlSWRzLnVuc2hpZnQoc291cmNlSWQpO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJhZ1N0YXJ0ID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ1N0YXJ0KGUpIHtcbiAgICB2YXIgX3RoaXM0ID0gdGhpcztcblxuICAgIHZhciBkcmFnU3RhcnRTb3VyY2VJZHMgPSB0aGlzLmRyYWdTdGFydFNvdXJjZUlkcztcblxuICAgIHRoaXMuZHJhZ1N0YXJ0U291cmNlSWRzID0gbnVsbDtcblxuICAgIHZhciBjbGllbnRPZmZzZXQgPSBfT2Zmc2V0VXRpbHMuZ2V0RXZlbnRDbGllbnRPZmZzZXQoZSk7XG5cbiAgICAvLyBEb24ndCBwdWJsaXNoIHRoZSBzb3VyY2UganVzdCB5ZXQgKHNlZSB3aHkgYmVsb3cpXG4gICAgdGhpcy5hY3Rpb25zLmJlZ2luRHJhZyhkcmFnU3RhcnRTb3VyY2VJZHMsIHtcbiAgICAgIHB1Ymxpc2hTb3VyY2U6IGZhbHNlLFxuICAgICAgZ2V0U291cmNlQ2xpZW50T2Zmc2V0OiB0aGlzLmdldFNvdXJjZUNsaWVudE9mZnNldCxcbiAgICAgIGNsaWVudE9mZnNldDogY2xpZW50T2Zmc2V0XG4gICAgfSk7XG5cbiAgICB2YXIgZGF0YVRyYW5zZmVyID0gZS5kYXRhVHJhbnNmZXI7XG5cbiAgICB2YXIgbmF0aXZlVHlwZSA9IF9OYXRpdmVEcmFnU291cmNlcy5tYXRjaE5hdGl2ZUl0ZW1UeXBlKGRhdGFUcmFuc2Zlcik7XG5cbiAgICBpZiAodGhpcy5tb25pdG9yLmlzRHJhZ2dpbmcoKSkge1xuICAgICAgaWYgKHR5cGVvZiBkYXRhVHJhbnNmZXIuc2V0RHJhZ0ltYWdlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIFVzZSBjdXN0b20gZHJhZyBpbWFnZSBpZiB1c2VyIHNwZWNpZmllcyBpdC5cbiAgICAgICAgLy8gSWYgY2hpbGQgZHJhZyBzb3VyY2UgcmVmdXNlcyBkcmFnIGJ1dCBwYXJlbnQgYWdyZWVzLFxuICAgICAgICAvLyB1c2UgcGFyZW50J3Mgbm9kZSBhcyBkcmFnIGltYWdlLiBOZWl0aGVyIHdvcmtzIGluIElFIHRob3VnaC5cbiAgICAgICAgdmFyIHNvdXJjZUlkID0gdGhpcy5tb25pdG9yLmdldFNvdXJjZUlkKCk7XG4gICAgICAgIHZhciBzb3VyY2VOb2RlID0gdGhpcy5zb3VyY2VOb2Rlc1tzb3VyY2VJZF07XG4gICAgICAgIHZhciBkcmFnUHJldmlldyA9IHRoaXMuc291cmNlUHJldmlld05vZGVzW3NvdXJjZUlkXSB8fCBzb3VyY2VOb2RlO1xuXG4gICAgICAgIHZhciBfZ2V0Q3VycmVudFNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucyA9IHRoaXMuZ2V0Q3VycmVudFNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucygpO1xuXG4gICAgICAgIHZhciBhbmNob3JYID0gX2dldEN1cnJlbnRTb3VyY2VQcmV2aWV3Tm9kZU9wdGlvbnMuYW5jaG9yWDtcbiAgICAgICAgdmFyIGFuY2hvclkgPSBfZ2V0Q3VycmVudFNvdXJjZVByZXZpZXdOb2RlT3B0aW9ucy5hbmNob3JZO1xuXG4gICAgICAgIHZhciBhbmNob3JQb2ludCA9IHsgYW5jaG9yWDogYW5jaG9yWCwgYW5jaG9yWTogYW5jaG9yWSB9O1xuICAgICAgICB2YXIgZHJhZ1ByZXZpZXdPZmZzZXQgPSBfT2Zmc2V0VXRpbHMuZ2V0RHJhZ1ByZXZpZXdPZmZzZXQoc291cmNlTm9kZSwgZHJhZ1ByZXZpZXcsIGNsaWVudE9mZnNldCwgYW5jaG9yUG9pbnQpO1xuICAgICAgICBkYXRhVHJhbnNmZXIuc2V0RHJhZ0ltYWdlKGRyYWdQcmV2aWV3LCBkcmFnUHJldmlld09mZnNldC54LCBkcmFnUHJldmlld09mZnNldC55KTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gRmlyZWZveCB3b24ndCBkcmFnIHdpdGhvdXQgc2V0dGluZyBkYXRhXG4gICAgICAgIGRhdGFUcmFuc2Zlci5zZXREYXRhKCdhcHBsaWNhdGlvbi9qc29uJywge30pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7fVxuICAgICAgLy8gSUUgZG9lc24ndCBzdXBwb3J0IE1JTUUgdHlwZXMgaW4gc2V0RGF0YVxuXG4gICAgICAvLyBTdG9yZSBkcmFnIHNvdXJjZSBub2RlIHNvIHdlIGNhbiBjaGVjayB3aGV0aGVyXG4gICAgICAvLyBpdCBpcyByZW1vdmVkIGZyb20gRE9NIGFuZCB0cmlnZ2VyIGVuZERyYWcgbWFudWFsbHkuXG4gICAgICB0aGlzLnNldEN1cnJlbnREcmFnU291cmNlTm9kZShlLnRhcmdldCk7XG5cbiAgICAgIC8vIE5vdyB3ZSBhcmUgcmVhZHkgdG8gcHVibGlzaCB0aGUgZHJhZyBzb3VyY2UuLiBvciBhcmUgd2Ugbm90P1xuXG4gICAgICB2YXIgX2dldEN1cnJlbnRTb3VyY2VQcmV2aWV3Tm9kZU9wdGlvbnMyID0gdGhpcy5nZXRDdXJyZW50U291cmNlUHJldmlld05vZGVPcHRpb25zKCk7XG5cbiAgICAgIHZhciBjYXB0dXJlRHJhZ2dpbmdTdGF0ZSA9IF9nZXRDdXJyZW50U291cmNlUHJldmlld05vZGVPcHRpb25zMi5jYXB0dXJlRHJhZ2dpbmdTdGF0ZTtcblxuICAgICAgaWYgKCFjYXB0dXJlRHJhZ2dpbmdTdGF0ZSkge1xuICAgICAgICAvLyBVc3VhbGx5IHdlIHdhbnQgdG8gcHVibGlzaCBpdCBpbiB0aGUgbmV4dCB0aWNrIHNvIHRoYXQgYnJvd3NlclxuICAgICAgICAvLyBpcyBhYmxlIHRvIHNjcmVlbnNob3QgdGhlIGN1cnJlbnQgKG5vdCB5ZXQgZHJhZ2dpbmcpIHN0YXRlLlxuICAgICAgICAvL1xuICAgICAgICAvLyBJdCBhbHNvIG5lYXRseSBhdm9pZHMgYSBzaXR1YXRpb24gd2hlcmUgcmVuZGVyKCkgcmV0dXJucyBudWxsXG4gICAgICAgIC8vIGluIHRoZSBzYW1lIHRpY2sgZm9yIHRoZSBzb3VyY2UgZWxlbWVudCwgYW5kIGJyb3dzZXIgZnJlYWtzIG91dC5cbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgcmV0dXJuIF90aGlzNC5hY3Rpb25zLnB1Ymxpc2hEcmFnU291cmNlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gSW4gc29tZSBjYXNlcyB0aGUgdXNlciBtYXkgd2FudCB0byBvdmVycmlkZSB0aGlzIGJlaGF2aW9yLCBlLmcuXG4gICAgICAgIC8vIHRvIHdvcmsgYXJvdW5kIElFIG5vdCBzdXBwb3J0aW5nIGN1c3RvbSBkcmFnIHByZXZpZXdzLlxuICAgICAgICAvL1xuICAgICAgICAvLyBXaGVuIHVzaW5nIGEgY3VzdG9tIGRyYWcgbGF5ZXIsIHRoZSBvbmx5IHdheSB0byBwcmV2ZW50XG4gICAgICAgIC8vIHRoZSBkZWZhdWx0IGRyYWcgcHJldmlldyBmcm9tIGRyYXdpbmcgaW4gSUUgaXMgdG8gc2NyZWVuc2hvdFxuICAgICAgICAvLyB0aGUgZHJhZ2dpbmcgc3RhdGUgaW4gd2hpY2ggdGhlIG5vZGUgaXRzZWxmIGhhcyB6ZXJvIG9wYWNpdHlcbiAgICAgICAgLy8gYW5kIGhlaWdodC4gSW4gdGhpcyBjYXNlLCB0aG91Z2gsIHJldHVybmluZyBudWxsIGZyb20gcmVuZGVyKClcbiAgICAgICAgLy8gd2lsbCBhYnJ1cHRseSBlbmQgdGhlIGRyYWdnaW5nLCB3aGljaCBpcyBub3Qgb2J2aW91cy5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gVGhpcyBpcyB0aGUgcmVhc29uIHN1Y2ggYmVoYXZpb3IgaXMgc3RyaWN0bHkgb3B0LWluLlxuICAgICAgICB0aGlzLmFjdGlvbnMucHVibGlzaERyYWdTb3VyY2UoKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG5hdGl2ZVR5cGUpIHtcbiAgICAgIC8vIEEgbmF0aXZlIGl0ZW0gKHN1Y2ggYXMgVVJMKSBkcmFnZ2VkIGZyb20gaW5zaWRlIHRoZSBkb2N1bWVudFxuICAgICAgdGhpcy5iZWdpbkRyYWdOYXRpdmVJdGVtKG5hdGl2ZVR5cGUpO1xuICAgIH0gZWxzZSBpZiAoIWRhdGFUcmFuc2Zlci50eXBlcyAmJiAoIWUudGFyZ2V0Lmhhc0F0dHJpYnV0ZSB8fCAhZS50YXJnZXQuaGFzQXR0cmlidXRlKCdkcmFnZ2FibGUnKSkpIHtcbiAgICAgIC8vIExvb2tzIGxpa2UgYSBTYWZhcmkgYnVnOiBkYXRhVHJhbnNmZXIudHlwZXMgaXMgbnVsbCwgYnV0IHRoZXJlIHdhcyBubyBkcmFnZ2FibGUuXG4gICAgICAvLyBKdXN0IGxldCBpdCBkcmFnLiBJdCdzIGEgbmF0aXZlIHR5cGUgKFVSTCBvciB0ZXh0KSBhbmQgd2lsbCBiZSBwaWNrZWQgdXAgaW4gZHJhZ2VudGVyIGhhbmRsZXIuXG4gICAgICByZXR1cm47XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIElmIGJ5IHRoaXMgdGltZSBubyBkcmFnIHNvdXJjZSByZWFjdGVkLCB0ZWxsIGJyb3dzZXIgbm90IHRvIGRyYWcuXG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgfVxuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJhZ0VuZENhcHR1cmUgPSBmdW5jdGlvbiBoYW5kbGVUb3BEcmFnRW5kQ2FwdHVyZSgpIHtcbiAgICBpZiAodGhpcy5jbGVhckN1cnJlbnREcmFnU291cmNlTm9kZSgpKSB7XG4gICAgICAvLyBGaXJlZm94IGNhbiBkaXNwYXRjaCB0aGlzIGV2ZW50IGluIGFuIGluZmluaXRlIGxvb3BcbiAgICAgIC8vIGlmIGRyYWdlbmQgaGFuZGxlciBkb2VzIHNvbWV0aGluZyBsaWtlIHNob3dpbmcgYW4gYWxlcnQuXG4gICAgICAvLyBPbmx5IHByb2NlZWQgaWYgd2UgaGF2ZSBub3QgaGFuZGxlZCBpdCBhbHJlYWR5LlxuICAgICAgdGhpcy5hY3Rpb25zLmVuZERyYWcoKTtcbiAgICB9XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5oYW5kbGVUb3BEcmFnRW50ZXJDYXB0dXJlID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ0VudGVyQ2FwdHVyZShlKSB7XG4gICAgdGhpcy5kcmFnRW50ZXJUYXJnZXRJZHMgPSBbXTtcblxuICAgIHZhciBpc0ZpcnN0RW50ZXIgPSB0aGlzLmVudGVyTGVhdmVDb3VudGVyLmVudGVyKGUudGFyZ2V0KTtcbiAgICBpZiAoIWlzRmlyc3RFbnRlciB8fCB0aGlzLm1vbml0b3IuaXNEcmFnZ2luZygpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIGRhdGFUcmFuc2ZlciA9IGUuZGF0YVRyYW5zZmVyO1xuXG4gICAgdmFyIG5hdGl2ZVR5cGUgPSBfTmF0aXZlRHJhZ1NvdXJjZXMubWF0Y2hOYXRpdmVJdGVtVHlwZShkYXRhVHJhbnNmZXIpO1xuXG4gICAgaWYgKG5hdGl2ZVR5cGUpIHtcbiAgICAgIC8vIEEgbmF0aXZlIGl0ZW0gKHN1Y2ggYXMgZmlsZSBvciBVUkwpIGRyYWdnZWQgZnJvbSBvdXRzaWRlIHRoZSBkb2N1bWVudFxuICAgICAgdGhpcy5iZWdpbkRyYWdOYXRpdmVJdGVtKG5hdGl2ZVR5cGUpO1xuICAgIH1cbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmhhbmRsZURyYWdFbnRlciA9IGZ1bmN0aW9uIGhhbmRsZURyYWdFbnRlcihlLCB0YXJnZXRJZCkge1xuICAgIHRoaXMuZHJhZ0VudGVyVGFyZ2V0SWRzLnVuc2hpZnQodGFyZ2V0SWQpO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJhZ0VudGVyID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ0VudGVyKGUpIHtcbiAgICB2YXIgX3RoaXM1ID0gdGhpcztcblxuICAgIHZhciBkcmFnRW50ZXJUYXJnZXRJZHMgPSB0aGlzLmRyYWdFbnRlclRhcmdldElkcztcblxuICAgIHRoaXMuZHJhZ0VudGVyVGFyZ2V0SWRzID0gW107XG5cbiAgICBpZiAoIXRoaXMubW9uaXRvci5pc0RyYWdnaW5nKCkpIHtcbiAgICAgIC8vIFRoaXMgaXMgcHJvYmFibHkgYSBuYXRpdmUgaXRlbSB0eXBlIHdlIGRvbid0IHVuZGVyc3RhbmQuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCFfQnJvd3NlckRldGVjdG9yLmlzRmlyZWZveCgpKSB7XG4gICAgICAvLyBEb24ndCBlbWl0IGhvdmVyIGluIGBkcmFnZW50ZXJgIG9uIEZpcmVmb3ggZHVlIHRvIGFuIGVkZ2UgY2FzZS5cbiAgICAgIC8vIElmIHRoZSB0YXJnZXQgY2hhbmdlcyBwb3NpdGlvbiBhcyB0aGUgcmVzdWx0IG9mIGBkcmFnZW50ZXJgLCBGaXJlZm94XG4gICAgICAvLyB3aWxsIHN0aWxsIGhhcHBpbHkgZGlzcGF0Y2ggYGRyYWdvdmVyYCBkZXNwaXRlIHRhcmdldCBiZWluZyBubyBsb25nZXJcbiAgICAgIC8vIHRoZXJlLiBUaGUgZWFzeSBzb2x1dGlvbiBpcyB0byBvbmx5IGZpcmUgYGhvdmVyYCBpbiBgZHJhZ292ZXJgIG9uIEZGLlxuICAgICAgdGhpcy5hY3Rpb25zLmhvdmVyKGRyYWdFbnRlclRhcmdldElkcywge1xuICAgICAgICBjbGllbnRPZmZzZXQ6IF9PZmZzZXRVdGlscy5nZXRFdmVudENsaWVudE9mZnNldChlKVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdmFyIGNhbkRyb3AgPSBkcmFnRW50ZXJUYXJnZXRJZHMuc29tZShmdW5jdGlvbiAodGFyZ2V0SWQpIHtcbiAgICAgIHJldHVybiBfdGhpczUubW9uaXRvci5jYW5Ecm9wT25UYXJnZXQodGFyZ2V0SWQpO1xuICAgIH0pO1xuXG4gICAgaWYgKGNhbkRyb3ApIHtcbiAgICAgIC8vIElFIHJlcXVpcmVzIHRoaXMgdG8gZmlyZSBkcmFnb3ZlciBldmVudHNcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSB0aGlzLmdldEN1cnJlbnREcm9wRWZmZWN0KCk7XG4gICAgfVxuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJhZ092ZXJDYXB0dXJlID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ092ZXJDYXB0dXJlKCkge1xuICAgIHRoaXMuZHJhZ092ZXJUYXJnZXRJZHMgPSBbXTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmhhbmRsZURyYWdPdmVyID0gZnVuY3Rpb24gaGFuZGxlRHJhZ092ZXIoZSwgdGFyZ2V0SWQpIHtcbiAgICB0aGlzLmRyYWdPdmVyVGFyZ2V0SWRzLnVuc2hpZnQodGFyZ2V0SWQpO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJhZ092ZXIgPSBmdW5jdGlvbiBoYW5kbGVUb3BEcmFnT3ZlcihlKSB7XG4gICAgdmFyIF90aGlzNiA9IHRoaXM7XG5cbiAgICB2YXIgZHJhZ092ZXJUYXJnZXRJZHMgPSB0aGlzLmRyYWdPdmVyVGFyZ2V0SWRzO1xuXG4gICAgdGhpcy5kcmFnT3ZlclRhcmdldElkcyA9IFtdO1xuXG4gICAgaWYgKCF0aGlzLm1vbml0b3IuaXNEcmFnZ2luZygpKSB7XG4gICAgICAvLyBUaGlzIGlzIHByb2JhYmx5IGEgbmF0aXZlIGl0ZW0gdHlwZSB3ZSBkb24ndCB1bmRlcnN0YW5kLlxuICAgICAgLy8gUHJldmVudCBkZWZhdWx0IFwiZHJvcCBhbmQgYmxvdyBhd2F5IHRoZSB3aG9sZSBkb2N1bWVudFwiIGFjdGlvbi5cbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSAnbm9uZSc7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdGhpcy5hY3Rpb25zLmhvdmVyKGRyYWdPdmVyVGFyZ2V0SWRzLCB7XG4gICAgICBjbGllbnRPZmZzZXQ6IF9PZmZzZXRVdGlscy5nZXRFdmVudENsaWVudE9mZnNldChlKVxuICAgIH0pO1xuXG4gICAgdmFyIGNhbkRyb3AgPSBkcmFnT3ZlclRhcmdldElkcy5zb21lKGZ1bmN0aW9uICh0YXJnZXRJZCkge1xuICAgICAgcmV0dXJuIF90aGlzNi5tb25pdG9yLmNhbkRyb3BPblRhcmdldCh0YXJnZXRJZCk7XG4gICAgfSk7XG5cbiAgICBpZiAoY2FuRHJvcCkge1xuICAgICAgLy8gU2hvdyB1c2VyLXNwZWNpZmllZCBkcm9wIGVmZmVjdC5cbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuZGF0YVRyYW5zZmVyLmRyb3BFZmZlY3QgPSB0aGlzLmdldEN1cnJlbnREcm9wRWZmZWN0KCk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmlzRHJhZ2dpbmdOYXRpdmVJdGVtKCkpIHtcbiAgICAgIC8vIERvbid0IHNob3cgYSBuaWNlIGN1cnNvciBidXQgc3RpbGwgcHJldmVudCBkZWZhdWx0XG4gICAgICAvLyBcImRyb3AgYW5kIGJsb3cgYXdheSB0aGUgd2hvbGUgZG9jdW1lbnRcIiBhY3Rpb24uXG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBlLmRhdGFUcmFuc2Zlci5kcm9wRWZmZWN0ID0gJ25vbmUnO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jaGVja0lmQ3VycmVudERyYWdTb3VyY2VSZWN0Q2hhbmdlZCgpKSB7XG4gICAgICAvLyBQcmV2ZW50IGFuaW1hdGluZyB0byBpbmNvcnJlY3QgcG9zaXRpb24uXG4gICAgICAvLyBEcm9wIGVmZmVjdCBtdXN0IGJlIG90aGVyIHRoYW4gJ25vbmUnIHRvIHByZXZlbnQgYW5pbWF0aW9uLlxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5kYXRhVHJhbnNmZXIuZHJvcEVmZmVjdCA9ICdtb3ZlJztcbiAgICB9XG4gIH07XG5cbiAgSFRNTDVCYWNrZW5kLnByb3RvdHlwZS5oYW5kbGVUb3BEcmFnTGVhdmVDYXB0dXJlID0gZnVuY3Rpb24gaGFuZGxlVG9wRHJhZ0xlYXZlQ2FwdHVyZShlKSB7XG4gICAgaWYgKHRoaXMuaXNEcmFnZ2luZ05hdGl2ZUl0ZW0oKSkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIH1cblxuICAgIHZhciBpc0xhc3RMZWF2ZSA9IHRoaXMuZW50ZXJMZWF2ZUNvdW50ZXIubGVhdmUoZS50YXJnZXQpO1xuICAgIGlmICghaXNMYXN0TGVhdmUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5pc0RyYWdnaW5nTmF0aXZlSXRlbSgpKSB7XG4gICAgICB0aGlzLmVuZERyYWdOYXRpdmVJdGVtKCk7XG4gICAgfVxuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJvcENhcHR1cmUgPSBmdW5jdGlvbiBoYW5kbGVUb3BEcm9wQ2FwdHVyZShlKSB7XG4gICAgdGhpcy5kcm9wVGFyZ2V0SWRzID0gW107XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuXG4gICAgaWYgKHRoaXMuaXNEcmFnZ2luZ05hdGl2ZUl0ZW0oKSkge1xuICAgICAgdGhpcy5jdXJyZW50TmF0aXZlU291cmNlLm11dGF0ZUl0ZW1CeVJlYWRpbmdEYXRhVHJhbnNmZXIoZS5kYXRhVHJhbnNmZXIpO1xuICAgIH1cblxuICAgIHRoaXMuZW50ZXJMZWF2ZUNvdW50ZXIucmVzZXQoKTtcbiAgfTtcblxuICBIVE1MNUJhY2tlbmQucHJvdG90eXBlLmhhbmRsZURyb3AgPSBmdW5jdGlvbiBoYW5kbGVEcm9wKGUsIHRhcmdldElkKSB7XG4gICAgdGhpcy5kcm9wVGFyZ2V0SWRzLnVuc2hpZnQodGFyZ2V0SWQpO1xuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlVG9wRHJvcCA9IGZ1bmN0aW9uIGhhbmRsZVRvcERyb3AoZSkge1xuICAgIHZhciBkcm9wVGFyZ2V0SWRzID0gdGhpcy5kcm9wVGFyZ2V0SWRzO1xuXG4gICAgdGhpcy5kcm9wVGFyZ2V0SWRzID0gW107XG5cbiAgICB0aGlzLmFjdGlvbnMuaG92ZXIoZHJvcFRhcmdldElkcywge1xuICAgICAgY2xpZW50T2Zmc2V0OiBfT2Zmc2V0VXRpbHMuZ2V0RXZlbnRDbGllbnRPZmZzZXQoZSlcbiAgICB9KTtcbiAgICB0aGlzLmFjdGlvbnMuZHJvcCgpO1xuXG4gICAgaWYgKHRoaXMuaXNEcmFnZ2luZ05hdGl2ZUl0ZW0oKSkge1xuICAgICAgdGhpcy5lbmREcmFnTmF0aXZlSXRlbSgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmVuZERyYWdJZlNvdXJjZVdhc1JlbW92ZWRGcm9tRE9NKCk7XG4gICAgfVxuICB9O1xuXG4gIEhUTUw1QmFja2VuZC5wcm90b3R5cGUuaGFuZGxlU2VsZWN0U3RhcnQgPSBmdW5jdGlvbiBoYW5kbGVTZWxlY3RTdGFydChlKSB7XG4gICAgdmFyIHRhcmdldCA9IGUudGFyZ2V0O1xuXG4gICAgLy8gT25seSBJRSByZXF1aXJlcyB1cyB0byBleHBsaWNpdGx5IHNheVxuICAgIC8vIHdlIHdhbnQgZHJhZyBkcm9wIG9wZXJhdGlvbiB0byBzdGFydFxuICAgIGlmICh0eXBlb2YgdGFyZ2V0LmRyYWdEcm9wICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gSW5wdXRzIGFuZCB0ZXh0YXJlYXMgc2hvdWxkIGJlIHNlbGVjdGFibGVcbiAgICBpZiAodGFyZ2V0LnRhZ05hbWUgPT09ICdJTlBVVCcgfHwgdGFyZ2V0LnRhZ05hbWUgPT09ICdTRUxFQ1QnIHx8IHRhcmdldC50YWdOYW1lID09PSAnVEVYVEFSRUEnIHx8IHRhcmdldC5pc0NvbnRlbnRFZGl0YWJsZSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEZvciBvdGhlciB0YXJnZXRzLCBhc2sgSUVcbiAgICAvLyB0byBlbmFibGUgZHJhZyBhbmQgZHJvcFxuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICB0YXJnZXQuZHJhZ0Ryb3AoKTtcbiAgfTtcblxuICByZXR1cm4gSFRNTDVCYWNrZW5kO1xufSkoKTtcblxuZXhwb3J0c1snZGVmYXVsdCddID0gSFRNTDVCYWNrZW5kO1xubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBNb25vdG9uaWNJbnRlcnBvbGFudCA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIE1vbm90b25pY0ludGVycG9sYW50KHhzLCB5cykge1xuICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBNb25vdG9uaWNJbnRlcnBvbGFudCk7XG5cbiAgICB2YXIgbGVuZ3RoID0geHMubGVuZ3RoO1xuXG4gICAgLy8gUmVhcnJhbmdlIHhzIGFuZCB5cyBzbyB0aGF0IHhzIGlzIHNvcnRlZFxuICAgIHZhciBpbmRleGVzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgaW5kZXhlcy5wdXNoKGkpO1xuICAgIH1cbiAgICBpbmRleGVzLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgIHJldHVybiB4c1thXSA8IHhzW2JdID8gLTEgOiAxO1xuICAgIH0pO1xuXG4gICAgLy8gR2V0IGNvbnNlY3V0aXZlIGRpZmZlcmVuY2VzIGFuZCBzbG9wZXNcbiAgICB2YXIgZHlzID0gW107XG4gICAgdmFyIGR4cyA9IFtdO1xuICAgIHZhciBtcyA9IFtdO1xuICAgIHZhciBkeCA9IHVuZGVmaW5lZDtcbiAgICB2YXIgZHkgPSB1bmRlZmluZWQ7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGggLSAxOyBpKyspIHtcbiAgICAgIGR4ID0geHNbaSArIDFdIC0geHNbaV07XG4gICAgICBkeSA9IHlzW2kgKyAxXSAtIHlzW2ldO1xuICAgICAgZHhzLnB1c2goZHgpO1xuICAgICAgZHlzLnB1c2goZHkpO1xuICAgICAgbXMucHVzaChkeSAvIGR4KTtcbiAgICB9XG5cbiAgICAvLyBHZXQgZGVncmVlLTEgY29lZmZpY2llbnRzXG4gICAgdmFyIGMxcyA9IFttc1swXV07XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBkeHMubGVuZ3RoIC0gMTsgaSsrKSB7XG4gICAgICB2YXIgX20gPSBtc1tpXTtcbiAgICAgIHZhciBtTmV4dCA9IG1zW2kgKyAxXTtcbiAgICAgIGlmIChfbSAqIG1OZXh0IDw9IDApIHtcbiAgICAgICAgYzFzLnB1c2goMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkeCA9IGR4c1tpXTtcbiAgICAgICAgdmFyIGR4TmV4dCA9IGR4c1tpICsgMV07XG4gICAgICAgIHZhciBjb21tb24gPSBkeCArIGR4TmV4dDtcbiAgICAgICAgYzFzLnB1c2goMyAqIGNvbW1vbiAvICgoY29tbW9uICsgZHhOZXh0KSAvIF9tICsgKGNvbW1vbiArIGR4KSAvIG1OZXh0KSk7XG4gICAgICB9XG4gICAgfVxuICAgIGMxcy5wdXNoKG1zW21zLmxlbmd0aCAtIDFdKTtcblxuICAgIC8vIEdldCBkZWdyZWUtMiBhbmQgZGVncmVlLTMgY29lZmZpY2llbnRzXG4gICAgdmFyIGMycyA9IFtdO1xuICAgIHZhciBjM3MgPSBbXTtcbiAgICB2YXIgbSA9IHVuZGVmaW5lZDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGMxcy5sZW5ndGggLSAxOyBpKyspIHtcbiAgICAgIG0gPSBtc1tpXTtcbiAgICAgIHZhciBjMSA9IGMxc1tpXTtcbiAgICAgIHZhciBpbnZEeCA9IDEgLyBkeHNbaV07XG4gICAgICB2YXIgY29tbW9uID0gYzEgKyBjMXNbaSArIDFdIC0gbSAtIG07XG4gICAgICBjMnMucHVzaCgobSAtIGMxIC0gY29tbW9uKSAqIGludkR4KTtcbiAgICAgIGMzcy5wdXNoKGNvbW1vbiAqIGludkR4ICogaW52RHgpO1xuICAgIH1cblxuICAgIHRoaXMueHMgPSB4cztcbiAgICB0aGlzLnlzID0geXM7XG4gICAgdGhpcy5jMXMgPSBjMXM7XG4gICAgdGhpcy5jMnMgPSBjMnM7XG4gICAgdGhpcy5jM3MgPSBjM3M7XG4gIH1cblxuICBNb25vdG9uaWNJbnRlcnBvbGFudC5wcm90b3R5cGUuaW50ZXJwb2xhdGUgPSBmdW5jdGlvbiBpbnRlcnBvbGF0ZSh4KSB7XG4gICAgdmFyIHhzID0gdGhpcy54cztcbiAgICB2YXIgeXMgPSB0aGlzLnlzO1xuICAgIHZhciBjMXMgPSB0aGlzLmMxcztcbiAgICB2YXIgYzJzID0gdGhpcy5jMnM7XG4gICAgdmFyIGMzcyA9IHRoaXMuYzNzO1xuXG4gICAgLy8gVGhlIHJpZ2h0bW9zdCBwb2ludCBpbiB0aGUgZGF0YXNldCBzaG91bGQgZ2l2ZSBhbiBleGFjdCByZXN1bHRcbiAgICB2YXIgaSA9IHhzLmxlbmd0aCAtIDE7XG4gICAgaWYgKHggPT09IHhzW2ldKSB7XG4gICAgICByZXR1cm4geXNbaV07XG4gICAgfVxuXG4gICAgLy8gU2VhcmNoIGZvciB0aGUgaW50ZXJ2YWwgeCBpcyBpbiwgcmV0dXJuaW5nIHRoZSBjb3JyZXNwb25kaW5nIHkgaWYgeCBpcyBvbmUgb2YgdGhlIG9yaWdpbmFsIHhzXG4gICAgdmFyIGxvdyA9IDA7XG4gICAgdmFyIGhpZ2ggPSBjM3MubGVuZ3RoIC0gMTtcbiAgICB2YXIgbWlkID0gdW5kZWZpbmVkO1xuICAgIHdoaWxlIChsb3cgPD0gaGlnaCkge1xuICAgICAgbWlkID0gTWF0aC5mbG9vcigwLjUgKiAobG93ICsgaGlnaCkpO1xuICAgICAgdmFyIHhIZXJlID0geHNbbWlkXTtcbiAgICAgIGlmICh4SGVyZSA8IHgpIHtcbiAgICAgICAgbG93ID0gbWlkICsgMTtcbiAgICAgIH0gZWxzZSBpZiAoeEhlcmUgPiB4KSB7XG4gICAgICAgIGhpZ2ggPSBtaWQgLSAxO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHlzW21pZF07XG4gICAgICB9XG4gICAgfVxuICAgIGkgPSBNYXRoLm1heCgwLCBoaWdoKTtcblxuICAgIC8vIEludGVycG9sYXRlXG4gICAgdmFyIGRpZmYgPSB4IC0geHNbaV07XG4gICAgdmFyIGRpZmZTcSA9IGRpZmYgKiBkaWZmO1xuICAgIHJldHVybiB5c1tpXSArIGMxc1tpXSAqIGRpZmYgKyBjMnNbaV0gKiBkaWZmU3EgKyBjM3NbaV0gKiBkaWZmICogZGlmZlNxO1xuICB9O1xuXG4gIHJldHVybiBNb25vdG9uaWNJbnRlcnBvbGFudDtcbn0pKCk7XG5cbmV4cG9ydHNbXCJkZWZhdWx0XCJdID0gTW9ub3RvbmljSW50ZXJwb2xhbnQ7XG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbXCJkZWZhdWx0XCJdOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxudmFyIF9uYXRpdmVUeXBlc0NvbmZpZztcblxuZXhwb3J0cy5jcmVhdGVOYXRpdmVEcmFnU291cmNlID0gY3JlYXRlTmF0aXZlRHJhZ1NvdXJjZTtcbmV4cG9ydHMubWF0Y2hOYXRpdmVJdGVtVHlwZSA9IG1hdGNoTmF0aXZlSXRlbVR5cGU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKG9iaikgeyBpZiAob2JqICYmIG9iai5fX2VzTW9kdWxlKSB7IHJldHVybiBvYmo7IH0gZWxzZSB7IHZhciBuZXdPYmogPSB7fTsgaWYgKG9iaiAhPSBudWxsKSB7IGZvciAodmFyIGtleSBpbiBvYmopIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIG5ld09ialtrZXldID0gb2JqW2tleV07IH0gfSBuZXdPYmpbJ2RlZmF1bHQnXSA9IG9iajsgcmV0dXJuIG5ld09iajsgfSB9XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcignQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uJyk7IH0gfVxuXG5mdW5jdGlvbiBfZGVmaW5lUHJvcGVydHkob2JqLCBrZXksIHZhbHVlKSB7IGlmIChrZXkgaW4gb2JqKSB7IE9iamVjdC5kZWZpbmVQcm9wZXJ0eShvYmosIGtleSwgeyB2YWx1ZTogdmFsdWUsIGVudW1lcmFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSwgd3JpdGFibGU6IHRydWUgfSk7IH0gZWxzZSB7IG9ialtrZXldID0gdmFsdWU7IH0gcmV0dXJuIG9iajsgfVxuXG52YXIgX05hdGl2ZVR5cGVzID0gcmVxdWlyZSgnLi9OYXRpdmVUeXBlcycpO1xuXG52YXIgTmF0aXZlVHlwZXMgPSBfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZChfTmF0aXZlVHlwZXMpO1xuXG5mdW5jdGlvbiBnZXREYXRhRnJvbURhdGFUcmFuc2ZlcihkYXRhVHJhbnNmZXIsIHR5cGVzVG9UcnksIGRlZmF1bHRWYWx1ZSkge1xuICB2YXIgcmVzdWx0ID0gdHlwZXNUb1RyeS5yZWR1Y2UoZnVuY3Rpb24gKHJlc3VsdFNvRmFyLCB0eXBlVG9UcnkpIHtcbiAgICByZXR1cm4gcmVzdWx0U29GYXIgfHwgZGF0YVRyYW5zZmVyLmdldERhdGEodHlwZVRvVHJ5KTtcbiAgfSwgbnVsbCk7XG5cbiAgcmV0dXJuIHJlc3VsdCAhPSBudWxsID8gLy8gZXNsaW50LWRpc2FibGUtbGluZSBlcWVxZXFcbiAgcmVzdWx0IDogZGVmYXVsdFZhbHVlO1xufVxuXG52YXIgbmF0aXZlVHlwZXNDb25maWcgPSAoX25hdGl2ZVR5cGVzQ29uZmlnID0ge30sIF9kZWZpbmVQcm9wZXJ0eShfbmF0aXZlVHlwZXNDb25maWcsIE5hdGl2ZVR5cGVzLkZJTEUsIHtcbiAgZXhwb3NlUHJvcGVydHk6ICdmaWxlcycsXG4gIG1hdGNoZXNUeXBlczogWydGaWxlcyddLFxuICBnZXREYXRhOiBmdW5jdGlvbiBnZXREYXRhKGRhdGFUcmFuc2Zlcikge1xuICAgIHJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChkYXRhVHJhbnNmZXIuZmlsZXMpO1xuICB9XG59KSwgX2RlZmluZVByb3BlcnR5KF9uYXRpdmVUeXBlc0NvbmZpZywgTmF0aXZlVHlwZXMuVVJMLCB7XG4gIGV4cG9zZVByb3BlcnR5OiAndXJscycsXG4gIG1hdGNoZXNUeXBlczogWydVcmwnLCAndGV4dC91cmktbGlzdCddLFxuICBnZXREYXRhOiBmdW5jdGlvbiBnZXREYXRhKGRhdGFUcmFuc2ZlciwgbWF0Y2hlc1R5cGVzKSB7XG4gICAgcmV0dXJuIGdldERhdGFGcm9tRGF0YVRyYW5zZmVyKGRhdGFUcmFuc2ZlciwgbWF0Y2hlc1R5cGVzLCAnJykuc3BsaXQoJ1xcbicpO1xuICB9XG59KSwgX2RlZmluZVByb3BlcnR5KF9uYXRpdmVUeXBlc0NvbmZpZywgTmF0aXZlVHlwZXMuVEVYVCwge1xuICBleHBvc2VQcm9wZXJ0eTogJ3RleHQnLFxuICBtYXRjaGVzVHlwZXM6IFsnVGV4dCcsICd0ZXh0L3BsYWluJ10sXG4gIGdldERhdGE6IGZ1bmN0aW9uIGdldERhdGEoZGF0YVRyYW5zZmVyLCBtYXRjaGVzVHlwZXMpIHtcbiAgICByZXR1cm4gZ2V0RGF0YUZyb21EYXRhVHJhbnNmZXIoZGF0YVRyYW5zZmVyLCBtYXRjaGVzVHlwZXMsICcnKTtcbiAgfVxufSksIF9uYXRpdmVUeXBlc0NvbmZpZyk7XG5cbmZ1bmN0aW9uIGNyZWF0ZU5hdGl2ZURyYWdTb3VyY2UodHlwZSkge1xuICB2YXIgX25hdGl2ZVR5cGVzQ29uZmlnJHR5cGUgPSBuYXRpdmVUeXBlc0NvbmZpZ1t0eXBlXTtcbiAgdmFyIGV4cG9zZVByb3BlcnR5ID0gX25hdGl2ZVR5cGVzQ29uZmlnJHR5cGUuZXhwb3NlUHJvcGVydHk7XG4gIHZhciBtYXRjaGVzVHlwZXMgPSBfbmF0aXZlVHlwZXNDb25maWckdHlwZS5tYXRjaGVzVHlwZXM7XG4gIHZhciBnZXREYXRhID0gX25hdGl2ZVR5cGVzQ29uZmlnJHR5cGUuZ2V0RGF0YTtcblxuICByZXR1cm4gKGZ1bmN0aW9uICgpIHtcbiAgICBmdW5jdGlvbiBOYXRpdmVEcmFnU291cmNlKCkge1xuICAgICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIE5hdGl2ZURyYWdTb3VyY2UpO1xuXG4gICAgICB0aGlzLml0ZW0gPSBPYmplY3QuZGVmaW5lUHJvcGVydGllcyh7fSwgX2RlZmluZVByb3BlcnR5KHt9LCBleHBvc2VQcm9wZXJ0eSwge1xuICAgICAgICBnZXQ6IGZ1bmN0aW9uIGdldCgpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbm8tY29uc29sZVxuICAgICAgICAgICdCcm93c2VyIGRvZXNuXFwndCBhbGxvdyByZWFkaW5nIFwiJyArIGV4cG9zZVByb3BlcnR5ICsgJ1wiIHVudGlsIHRoZSBkcm9wIGV2ZW50LicpO1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9LFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgICAgIGVudW1lcmFibGU6IHRydWVcbiAgICAgIH0pKTtcbiAgICB9XG5cbiAgICBOYXRpdmVEcmFnU291cmNlLnByb3RvdHlwZS5tdXRhdGVJdGVtQnlSZWFkaW5nRGF0YVRyYW5zZmVyID0gZnVuY3Rpb24gbXV0YXRlSXRlbUJ5UmVhZGluZ0RhdGFUcmFuc2ZlcihkYXRhVHJhbnNmZXIpIHtcbiAgICAgIGRlbGV0ZSB0aGlzLml0ZW1bZXhwb3NlUHJvcGVydHldO1xuICAgICAgdGhpcy5pdGVtW2V4cG9zZVByb3BlcnR5XSA9IGdldERhdGEoZGF0YVRyYW5zZmVyLCBtYXRjaGVzVHlwZXMpO1xuICAgIH07XG5cbiAgICBOYXRpdmVEcmFnU291cmNlLnByb3RvdHlwZS5jYW5EcmFnID0gZnVuY3Rpb24gY2FuRHJhZygpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH07XG5cbiAgICBOYXRpdmVEcmFnU291cmNlLnByb3RvdHlwZS5iZWdpbkRyYWcgPSBmdW5jdGlvbiBiZWdpbkRyYWcoKSB7XG4gICAgICByZXR1cm4gdGhpcy5pdGVtO1xuICAgIH07XG5cbiAgICBOYXRpdmVEcmFnU291cmNlLnByb3RvdHlwZS5pc0RyYWdnaW5nID0gZnVuY3Rpb24gaXNEcmFnZ2luZyhtb25pdG9yLCBoYW5kbGUpIHtcbiAgICAgIHJldHVybiBoYW5kbGUgPT09IG1vbml0b3IuZ2V0U291cmNlSWQoKTtcbiAgICB9O1xuXG4gICAgTmF0aXZlRHJhZ1NvdXJjZS5wcm90b3R5cGUuZW5kRHJhZyA9IGZ1bmN0aW9uIGVuZERyYWcoKSB7fTtcblxuICAgIHJldHVybiBOYXRpdmVEcmFnU291cmNlO1xuICB9KSgpO1xufVxuXG5mdW5jdGlvbiBtYXRjaE5hdGl2ZUl0ZW1UeXBlKGRhdGFUcmFuc2Zlcikge1xuICB2YXIgZGF0YVRyYW5zZmVyVHlwZXMgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChkYXRhVHJhbnNmZXIudHlwZXMgfHwgW10pO1xuXG4gIHJldHVybiBPYmplY3Qua2V5cyhuYXRpdmVUeXBlc0NvbmZpZykuZmlsdGVyKGZ1bmN0aW9uIChuYXRpdmVJdGVtVHlwZSkge1xuICAgIHZhciBtYXRjaGVzVHlwZXMgPSBuYXRpdmVUeXBlc0NvbmZpZ1tuYXRpdmVJdGVtVHlwZV0ubWF0Y2hlc1R5cGVzO1xuXG4gICAgcmV0dXJuIG1hdGNoZXNUeXBlcy5zb21lKGZ1bmN0aW9uICh0KSB7XG4gICAgICByZXR1cm4gZGF0YVRyYW5zZmVyVHlwZXMuaW5kZXhPZih0KSA+IC0xO1xuICAgIH0pO1xuICB9KVswXSB8fCBudWxsO1xufSIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbnZhciBGSUxFID0gJ19fTkFUSVZFX0ZJTEVfXyc7XG5leHBvcnRzLkZJTEUgPSBGSUxFO1xudmFyIFVSTCA9ICdfX05BVElWRV9VUkxfXyc7XG5leHBvcnRzLlVSTCA9IFVSTDtcbnZhciBURVhUID0gJ19fTkFUSVZFX1RFWFRfXyc7XG5leHBvcnRzLlRFWFQgPSBURVhUOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuZ2V0Tm9kZUNsaWVudE9mZnNldCA9IGdldE5vZGVDbGllbnRPZmZzZXQ7XG5leHBvcnRzLmdldEV2ZW50Q2xpZW50T2Zmc2V0ID0gZ2V0RXZlbnRDbGllbnRPZmZzZXQ7XG5leHBvcnRzLmdldERyYWdQcmV2aWV3T2Zmc2V0ID0gZ2V0RHJhZ1ByZXZpZXdPZmZzZXQ7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxudmFyIF9Ccm93c2VyRGV0ZWN0b3IgPSByZXF1aXJlKCcuL0Jyb3dzZXJEZXRlY3RvcicpO1xuXG52YXIgX01vbm90b25pY0ludGVycG9sYW50ID0gcmVxdWlyZSgnLi9Nb25vdG9uaWNJbnRlcnBvbGFudCcpO1xuXG52YXIgX01vbm90b25pY0ludGVycG9sYW50MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX01vbm90b25pY0ludGVycG9sYW50KTtcblxudmFyIEVMRU1FTlRfTk9ERSA9IDE7XG5cbmZ1bmN0aW9uIGdldE5vZGVDbGllbnRPZmZzZXQobm9kZSkge1xuICB2YXIgZWwgPSBub2RlLm5vZGVUeXBlID09PSBFTEVNRU5UX05PREUgPyBub2RlIDogbm9kZS5wYXJlbnRFbGVtZW50O1xuXG4gIGlmICghZWwpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIHZhciBfZWwkZ2V0Qm91bmRpbmdDbGllbnRSZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG5cbiAgdmFyIHRvcCA9IF9lbCRnZXRCb3VuZGluZ0NsaWVudFJlY3QudG9wO1xuICB2YXIgbGVmdCA9IF9lbCRnZXRCb3VuZGluZ0NsaWVudFJlY3QubGVmdDtcblxuICByZXR1cm4geyB4OiBsZWZ0LCB5OiB0b3AgfTtcbn1cblxuZnVuY3Rpb24gZ2V0RXZlbnRDbGllbnRPZmZzZXQoZSkge1xuICByZXR1cm4ge1xuICAgIHg6IGUuY2xpZW50WCxcbiAgICB5OiBlLmNsaWVudFlcbiAgfTtcbn1cblxuZnVuY3Rpb24gZ2V0RHJhZ1ByZXZpZXdPZmZzZXQoc291cmNlTm9kZSwgZHJhZ1ByZXZpZXcsIGNsaWVudE9mZnNldCwgYW5jaG9yUG9pbnQpIHtcbiAgLy8gVGhlIGJyb3dzZXJzIHdpbGwgdXNlIHRoZSBpbWFnZSBpbnRyaW5zaWMgc2l6ZSB1bmRlciBkaWZmZXJlbnQgY29uZGl0aW9ucy5cbiAgLy8gRmlyZWZveCBvbmx5IGNhcmVzIGlmIGl0J3MgYW4gaW1hZ2UsIGJ1dCBXZWJLaXQgYWxzbyB3YW50cyBpdCB0byBiZSBkZXRhY2hlZC5cbiAgdmFyIGlzSW1hZ2UgPSBkcmFnUHJldmlldy5ub2RlTmFtZSA9PT0gJ0lNRycgJiYgKF9Ccm93c2VyRGV0ZWN0b3IuaXNGaXJlZm94KCkgfHwgIWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jb250YWlucyhkcmFnUHJldmlldykpO1xuICB2YXIgZHJhZ1ByZXZpZXdOb2RlID0gaXNJbWFnZSA/IHNvdXJjZU5vZGUgOiBkcmFnUHJldmlldztcblxuICB2YXIgZHJhZ1ByZXZpZXdOb2RlT2Zmc2V0RnJvbUNsaWVudCA9IGdldE5vZGVDbGllbnRPZmZzZXQoZHJhZ1ByZXZpZXdOb2RlKTtcbiAgdmFyIG9mZnNldEZyb21EcmFnUHJldmlldyA9IHtcbiAgICB4OiBjbGllbnRPZmZzZXQueCAtIGRyYWdQcmV2aWV3Tm9kZU9mZnNldEZyb21DbGllbnQueCxcbiAgICB5OiBjbGllbnRPZmZzZXQueSAtIGRyYWdQcmV2aWV3Tm9kZU9mZnNldEZyb21DbGllbnQueVxuICB9O1xuXG4gIHZhciBzb3VyY2VXaWR0aCA9IHNvdXJjZU5vZGUub2Zmc2V0V2lkdGg7XG4gIHZhciBzb3VyY2VIZWlnaHQgPSBzb3VyY2VOb2RlLm9mZnNldEhlaWdodDtcbiAgdmFyIGFuY2hvclggPSBhbmNob3JQb2ludC5hbmNob3JYO1xuICB2YXIgYW5jaG9yWSA9IGFuY2hvclBvaW50LmFuY2hvclk7XG5cbiAgdmFyIGRyYWdQcmV2aWV3V2lkdGggPSBpc0ltYWdlID8gZHJhZ1ByZXZpZXcud2lkdGggOiBzb3VyY2VXaWR0aDtcbiAgdmFyIGRyYWdQcmV2aWV3SGVpZ2h0ID0gaXNJbWFnZSA/IGRyYWdQcmV2aWV3LmhlaWdodCA6IHNvdXJjZUhlaWdodDtcblxuICAvLyBXb3JrIGFyb3VuZCBAMnggY29vcmRpbmF0ZSBkaXNjcmVwYW5jaWVzIGluIGJyb3dzZXJzXG4gIGlmIChfQnJvd3NlckRldGVjdG9yLmlzU2FmYXJpKCkgJiYgaXNJbWFnZSkge1xuICAgIGRyYWdQcmV2aWV3SGVpZ2h0IC89IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvO1xuICAgIGRyYWdQcmV2aWV3V2lkdGggLz0gd2luZG93LmRldmljZVBpeGVsUmF0aW87XG4gIH0gZWxzZSBpZiAoX0Jyb3dzZXJEZXRlY3Rvci5pc0ZpcmVmb3goKSAmJiAhaXNJbWFnZSkge1xuICAgIGRyYWdQcmV2aWV3SGVpZ2h0ICo9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvO1xuICAgIGRyYWdQcmV2aWV3V2lkdGggKj0gd2luZG93LmRldmljZVBpeGVsUmF0aW87XG4gIH1cblxuICAvLyBJbnRlcnBvbGF0ZSBjb29yZGluYXRlcyBkZXBlbmRpbmcgb24gYW5jaG9yIHBvaW50XG4gIC8vIElmIHlvdSBrbm93IGEgc2ltcGxlciB3YXkgdG8gZG8gdGhpcywgbGV0IG1lIGtub3dcbiAgdmFyIGludGVycG9sYW50WCA9IG5ldyBfTW9ub3RvbmljSW50ZXJwb2xhbnQyWydkZWZhdWx0J10oWzAsIDAuNSwgMV0sIFtcbiAgLy8gRG9jayB0byB0aGUgbGVmdFxuICBvZmZzZXRGcm9tRHJhZ1ByZXZpZXcueCxcbiAgLy8gQWxpZ24gYXQgdGhlIGNlbnRlclxuICBvZmZzZXRGcm9tRHJhZ1ByZXZpZXcueCAvIHNvdXJjZVdpZHRoICogZHJhZ1ByZXZpZXdXaWR0aCxcbiAgLy8gRG9jayB0byB0aGUgcmlnaHRcbiAgb2Zmc2V0RnJvbURyYWdQcmV2aWV3LnggKyBkcmFnUHJldmlld1dpZHRoIC0gc291cmNlV2lkdGhdKTtcbiAgdmFyIGludGVycG9sYW50WSA9IG5ldyBfTW9ub3RvbmljSW50ZXJwb2xhbnQyWydkZWZhdWx0J10oWzAsIDAuNSwgMV0sIFtcbiAgLy8gRG9jayB0byB0aGUgdG9wXG4gIG9mZnNldEZyb21EcmFnUHJldmlldy55LFxuICAvLyBBbGlnbiBhdCB0aGUgY2VudGVyXG4gIG9mZnNldEZyb21EcmFnUHJldmlldy55IC8gc291cmNlSGVpZ2h0ICogZHJhZ1ByZXZpZXdIZWlnaHQsXG4gIC8vIERvY2sgdG8gdGhlIGJvdHRvbVxuICBvZmZzZXRGcm9tRHJhZ1ByZXZpZXcueSArIGRyYWdQcmV2aWV3SGVpZ2h0IC0gc291cmNlSGVpZ2h0XSk7XG4gIHZhciB4ID0gaW50ZXJwb2xhbnRYLmludGVycG9sYXRlKGFuY2hvclgpO1xuICB2YXIgeSA9IGludGVycG9sYW50WS5pbnRlcnBvbGF0ZShhbmNob3JZKTtcblxuICAvLyBXb3JrIGFyb3VuZCBTYWZhcmkgOCBwb3NpdGlvbmluZyBidWdcbiAgaWYgKF9Ccm93c2VyRGV0ZWN0b3IuaXNTYWZhcmkoKSAmJiBpc0ltYWdlKSB7XG4gICAgLy8gV2UnbGwgaGF2ZSB0byB3YWl0IGZvciBAM3ggdG8gc2VlIGlmIHRoaXMgaXMgZW50aXJlbHkgY29ycmVjdFxuICAgIHkgKz0gKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIC0gMSkgKiBkcmFnUHJldmlld0hlaWdodDtcbiAgfVxuXG4gIHJldHVybiB7IHg6IHgsIHk6IHkgfTtcbn0iLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBnZXRFbXB0eUltYWdlO1xudmFyIGVtcHR5SW1hZ2UgPSB1bmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGdldEVtcHR5SW1hZ2UoKSB7XG4gIGlmICghZW1wdHlJbWFnZSkge1xuICAgIGVtcHR5SW1hZ2UgPSBuZXcgSW1hZ2UoKTtcbiAgICBlbXB0eUltYWdlLnNyYyA9ICdkYXRhOmltYWdlL2dpZjtiYXNlNjQsUjBsR09EbGhBUUFCQUFBQUFDSDVCQUVLQUFFQUxBQUFBQUFCQUFFQUFBSUNUQUVBT3c9PSc7XG4gIH1cblxuICByZXR1cm4gZW1wdHlJbWFnZTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gY3JlYXRlSFRNTDVCYWNrZW5kO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVXaWxkY2FyZChvYmopIHsgaWYgKG9iaiAmJiBvYmouX19lc01vZHVsZSkgeyByZXR1cm4gb2JqOyB9IGVsc2UgeyB2YXIgbmV3T2JqID0ge307IGlmIChvYmogIT0gbnVsbCkgeyBmb3IgKHZhciBrZXkgaW4gb2JqKSB7IGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpKSBuZXdPYmpba2V5XSA9IG9ialtrZXldOyB9IH0gbmV3T2JqWydkZWZhdWx0J10gPSBvYmo7IHJldHVybiBuZXdPYmo7IH0gfVxuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfSFRNTDVCYWNrZW5kID0gcmVxdWlyZSgnLi9IVE1MNUJhY2tlbmQnKTtcblxudmFyIF9IVE1MNUJhY2tlbmQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfSFRNTDVCYWNrZW5kKTtcblxudmFyIF9nZXRFbXB0eUltYWdlID0gcmVxdWlyZSgnLi9nZXRFbXB0eUltYWdlJyk7XG5cbnZhciBfZ2V0RW1wdHlJbWFnZTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9nZXRFbXB0eUltYWdlKTtcblxudmFyIF9OYXRpdmVUeXBlcyA9IHJlcXVpcmUoJy4vTmF0aXZlVHlwZXMnKTtcblxudmFyIE5hdGl2ZVR5cGVzID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoX05hdGl2ZVR5cGVzKTtcblxuZXhwb3J0cy5OYXRpdmVUeXBlcyA9IE5hdGl2ZVR5cGVzO1xuZXhwb3J0cy5nZXRFbXB0eUltYWdlID0gX2dldEVtcHR5SW1hZ2UyWydkZWZhdWx0J107XG5cbmZ1bmN0aW9uIGNyZWF0ZUhUTUw1QmFja2VuZChtYW5hZ2VyKSB7XG4gIHJldHVybiBuZXcgX0hUTUw1QmFja2VuZDJbJ2RlZmF1bHQnXShtYW5hZ2VyKTtcbn0iLCJcInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbXCJkZWZhdWx0XCJdID0gc2hhbGxvd0VxdWFsO1xuXG5mdW5jdGlvbiBzaGFsbG93RXF1YWwob2JqQSwgb2JqQikge1xuICBpZiAob2JqQSA9PT0gb2JqQikge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdmFyIGtleXNBID0gT2JqZWN0LmtleXMob2JqQSk7XG4gIHZhciBrZXlzQiA9IE9iamVjdC5rZXlzKG9iakIpO1xuXG4gIGlmIChrZXlzQS5sZW5ndGggIT09IGtleXNCLmxlbmd0aCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFRlc3QgZm9yIEEncyBrZXlzIGRpZmZlcmVudCBmcm9tIEIuXG4gIHZhciBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5O1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGtleXNBLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKCFoYXNPd24uY2FsbChvYmpCLCBrZXlzQVtpXSkgfHwgb2JqQVtrZXlzQVtpXV0gIT09IG9iakJba2V5c0FbaV1dKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgdmFyIHZhbEEgPSBvYmpBW2tleXNBW2ldXTtcbiAgICB2YXIgdmFsQiA9IG9iakJba2V5c0FbaV1dO1xuXG4gICAgaWYgKHZhbEEgIT09IHZhbEIpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzW1wiZGVmYXVsdFwiXTsiLCJ2YXIgcm9vdCA9IHJlcXVpcmUoJy4vX3Jvb3QnKTtcblxuLyoqIEJ1aWx0LWluIHZhbHVlIHJlZmVyZW5jZXMuICovXG52YXIgUmVmbGVjdCA9IHJvb3QuUmVmbGVjdDtcblxubW9kdWxlLmV4cG9ydHMgPSBSZWZsZWN0O1xuIiwidmFyIGVxID0gcmVxdWlyZSgnLi9lcScpO1xuXG4vKiogVXNlZCBmb3IgYnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMuICovXG52YXIgb2JqZWN0UHJvdG8gPSBPYmplY3QucHJvdG90eXBlO1xuXG4vKiogVXNlZCB0byBjaGVjayBvYmplY3RzIGZvciBvd24gcHJvcGVydGllcy4gKi9cbnZhciBoYXNPd25Qcm9wZXJ0eSA9IG9iamVjdFByb3RvLmhhc093blByb3BlcnR5O1xuXG4vKipcbiAqIFVzZWQgYnkgYF8uZGVmYXVsdHNgIHRvIGN1c3RvbWl6ZSBpdHMgYF8uYXNzaWduSW5gIHVzZS5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHsqfSBvYmpWYWx1ZSBUaGUgZGVzdGluYXRpb24gdmFsdWUuXG4gKiBAcGFyYW0geyp9IHNyY1ZhbHVlIFRoZSBzb3VyY2UgdmFsdWUuXG4gKiBAcGFyYW0ge3N0cmluZ30ga2V5IFRoZSBrZXkgb2YgdGhlIHByb3BlcnR5IHRvIGFzc2lnbi5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIHBhcmVudCBvYmplY3Qgb2YgYG9ialZhbHVlYC5cbiAqIEByZXR1cm5zIHsqfSBSZXR1cm5zIHRoZSB2YWx1ZSB0byBhc3NpZ24uXG4gKi9cbmZ1bmN0aW9uIGFzc2lnbkluRGVmYXVsdHMob2JqVmFsdWUsIHNyY1ZhbHVlLCBrZXksIG9iamVjdCkge1xuICBpZiAob2JqVmFsdWUgPT09IHVuZGVmaW5lZCB8fFxuICAgICAgKGVxKG9ialZhbHVlLCBvYmplY3RQcm90b1trZXldKSAmJiAhaGFzT3duUHJvcGVydHkuY2FsbChvYmplY3QsIGtleSkpKSB7XG4gICAgcmV0dXJuIHNyY1ZhbHVlO1xuICB9XG4gIHJldHVybiBvYmpWYWx1ZTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBhc3NpZ25JbkRlZmF1bHRzO1xuIiwidmFyIGVxID0gcmVxdWlyZSgnLi9lcScpO1xuXG4vKiogVXNlZCBmb3IgYnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMuICovXG52YXIgb2JqZWN0UHJvdG8gPSBPYmplY3QucHJvdG90eXBlO1xuXG4vKiogVXNlZCB0byBjaGVjayBvYmplY3RzIGZvciBvd24gcHJvcGVydGllcy4gKi9cbnZhciBoYXNPd25Qcm9wZXJ0eSA9IG9iamVjdFByb3RvLmhhc093blByb3BlcnR5O1xuXG4vKipcbiAqIEFzc2lnbnMgYHZhbHVlYCB0byBga2V5YCBvZiBgb2JqZWN0YCBpZiB0aGUgZXhpc3RpbmcgdmFsdWUgaXMgbm90IGVxdWl2YWxlbnRcbiAqIHVzaW5nIFtgU2FtZVZhbHVlWmVyb2BdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLXNhbWV2YWx1ZXplcm8pXG4gKiBmb3IgZXF1YWxpdHkgY29tcGFyaXNvbnMuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIG9iamVjdCB0byBtb2RpZnkuXG4gKiBAcGFyYW0ge3N0cmluZ30ga2V5IFRoZSBrZXkgb2YgdGhlIHByb3BlcnR5IHRvIGFzc2lnbi5cbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGFzc2lnbi5cbiAqL1xuZnVuY3Rpb24gYXNzaWduVmFsdWUob2JqZWN0LCBrZXksIHZhbHVlKSB7XG4gIHZhciBvYmpWYWx1ZSA9IG9iamVjdFtrZXldO1xuICBpZiAoIShoYXNPd25Qcm9wZXJ0eS5jYWxsKG9iamVjdCwga2V5KSAmJiBlcShvYmpWYWx1ZSwgdmFsdWUpKSB8fFxuICAgICAgKHZhbHVlID09PSB1bmRlZmluZWQgJiYgIShrZXkgaW4gb2JqZWN0KSkpIHtcbiAgICBvYmplY3Rba2V5XSA9IHZhbHVlO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYXNzaWduVmFsdWU7XG4iLCJ2YXIgYXJyYXlQdXNoID0gcmVxdWlyZSgnLi9fYXJyYXlQdXNoJyksXG4gICAgaXNGbGF0dGVuYWJsZSA9IHJlcXVpcmUoJy4vX2lzRmxhdHRlbmFibGUnKTtcblxuLyoqXG4gKiBUaGUgYmFzZSBpbXBsZW1lbnRhdGlvbiBvZiBgXy5mbGF0dGVuYCB3aXRoIHN1cHBvcnQgZm9yIHJlc3RyaWN0aW5nIGZsYXR0ZW5pbmcuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7QXJyYXl9IGFycmF5IFRoZSBhcnJheSB0byBmbGF0dGVuLlxuICogQHBhcmFtIHtudW1iZXJ9IGRlcHRoIFRoZSBtYXhpbXVtIHJlY3Vyc2lvbiBkZXB0aC5cbiAqIEBwYXJhbSB7Ym9vbGVhbn0gW3ByZWRpY2F0ZT1pc0ZsYXR0ZW5hYmxlXSBUaGUgZnVuY3Rpb24gaW52b2tlZCBwZXIgaXRlcmF0aW9uLlxuICogQHBhcmFtIHtib29sZWFufSBbaXNTdHJpY3RdIFJlc3RyaWN0IHRvIHZhbHVlcyB0aGF0IHBhc3MgYHByZWRpY2F0ZWAgY2hlY2tzLlxuICogQHBhcmFtIHtBcnJheX0gW3Jlc3VsdD1bXV0gVGhlIGluaXRpYWwgcmVzdWx0IHZhbHVlLlxuICogQHJldHVybnMge0FycmF5fSBSZXR1cm5zIHRoZSBuZXcgZmxhdHRlbmVkIGFycmF5LlxuICovXG5mdW5jdGlvbiBiYXNlRmxhdHRlbihhcnJheSwgZGVwdGgsIHByZWRpY2F0ZSwgaXNTdHJpY3QsIHJlc3VsdCkge1xuICB2YXIgaW5kZXggPSAtMSxcbiAgICAgIGxlbmd0aCA9IGFycmF5Lmxlbmd0aDtcblxuICBwcmVkaWNhdGUgfHwgKHByZWRpY2F0ZSA9IGlzRmxhdHRlbmFibGUpO1xuICByZXN1bHQgfHwgKHJlc3VsdCA9IFtdKTtcblxuICB3aGlsZSAoKytpbmRleCA8IGxlbmd0aCkge1xuICAgIHZhciB2YWx1ZSA9IGFycmF5W2luZGV4XTtcbiAgICBpZiAoZGVwdGggPiAwICYmIHByZWRpY2F0ZSh2YWx1ZSkpIHtcbiAgICAgIGlmIChkZXB0aCA+IDEpIHtcbiAgICAgICAgLy8gUmVjdXJzaXZlbHkgZmxhdHRlbiBhcnJheXMgKHN1c2NlcHRpYmxlIHRvIGNhbGwgc3RhY2sgbGltaXRzKS5cbiAgICAgICAgYmFzZUZsYXR0ZW4odmFsdWUsIGRlcHRoIC0gMSwgcHJlZGljYXRlLCBpc1N0cmljdCwgcmVzdWx0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFycmF5UHVzaChyZXN1bHQsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKCFpc1N0cmljdCkge1xuICAgICAgcmVzdWx0W3Jlc3VsdC5sZW5ndGhdID0gdmFsdWU7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gYmFzZUZsYXR0ZW47XG4iLCJ2YXIgUmVmbGVjdCA9IHJlcXVpcmUoJy4vX1JlZmxlY3QnKSxcbiAgICBpdGVyYXRvclRvQXJyYXkgPSByZXF1aXJlKCcuL19pdGVyYXRvclRvQXJyYXknKTtcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqIEJ1aWx0LWluIHZhbHVlIHJlZmVyZW5jZXMuICovXG52YXIgZW51bWVyYXRlID0gUmVmbGVjdCA/IFJlZmxlY3QuZW51bWVyYXRlIDogdW5kZWZpbmVkLFxuICAgIHByb3BlcnR5SXNFbnVtZXJhYmxlID0gb2JqZWN0UHJvdG8ucHJvcGVydHlJc0VudW1lcmFibGU7XG5cbi8qKlxuICogVGhlIGJhc2UgaW1wbGVtZW50YXRpb24gb2YgYF8ua2V5c0luYCB3aGljaCBkb2Vzbid0IHNraXAgdGhlIGNvbnN0cnVjdG9yXG4gKiBwcm9wZXJ0eSBvZiBwcm90b3R5cGVzIG9yIHRyZWF0IHNwYXJzZSBhcnJheXMgYXMgZGVuc2UuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIG9iamVjdCB0byBxdWVyeS5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgYXJyYXkgb2YgcHJvcGVydHkgbmFtZXMuXG4gKi9cbmZ1bmN0aW9uIGJhc2VLZXlzSW4ob2JqZWN0KSB7XG4gIG9iamVjdCA9IG9iamVjdCA9PSBudWxsID8gb2JqZWN0IDogT2JqZWN0KG9iamVjdCk7XG5cbiAgdmFyIHJlc3VsdCA9IFtdO1xuICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgcmVzdWx0LnB1c2goa2V5KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBGYWxsYmFjayBmb3IgSUUgPCA5IHdpdGggZXM2LXNoaW0uXG5pZiAoZW51bWVyYXRlICYmICFwcm9wZXJ0eUlzRW51bWVyYWJsZS5jYWxsKHsgJ3ZhbHVlT2YnOiAxIH0sICd2YWx1ZU9mJykpIHtcbiAgYmFzZUtleXNJbiA9IGZ1bmN0aW9uKG9iamVjdCkge1xuICAgIHJldHVybiBpdGVyYXRvclRvQXJyYXkoZW51bWVyYXRlKG9iamVjdCkpO1xuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VLZXlzSW47XG4iLCIvKipcbiAqIFRoZSBiYXNlIGltcGxlbWVudGF0aW9uIG9mIGBfLnRpbWVzYCB3aXRob3V0IHN1cHBvcnQgZm9yIGl0ZXJhdGVlIHNob3J0aGFuZHNcbiAqIG9yIG1heCBhcnJheSBsZW5ndGggY2hlY2tzLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge251bWJlcn0gbiBUaGUgbnVtYmVyIG9mIHRpbWVzIHRvIGludm9rZSBgaXRlcmF0ZWVgLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gaXRlcmF0ZWUgVGhlIGZ1bmN0aW9uIGludm9rZWQgcGVyIGl0ZXJhdGlvbi5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgYXJyYXkgb2YgcmVzdWx0cy5cbiAqL1xuZnVuY3Rpb24gYmFzZVRpbWVzKG4sIGl0ZXJhdGVlKSB7XG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgcmVzdWx0ID0gQXJyYXkobik7XG5cbiAgd2hpbGUgKCsraW5kZXggPCBuKSB7XG4gICAgcmVzdWx0W2luZGV4XSA9IGl0ZXJhdGVlKGluZGV4KTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGJhc2VUaW1lcztcbiIsInZhciBhc3NpZ25WYWx1ZSA9IHJlcXVpcmUoJy4vX2Fzc2lnblZhbHVlJyk7XG5cbi8qKlxuICogQ29waWVzIHByb3BlcnRpZXMgb2YgYHNvdXJjZWAgdG8gYG9iamVjdGAuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7T2JqZWN0fSBzb3VyY2UgVGhlIG9iamVjdCB0byBjb3B5IHByb3BlcnRpZXMgZnJvbS5cbiAqIEBwYXJhbSB7QXJyYXl9IHByb3BzIFRoZSBwcm9wZXJ0eSBpZGVudGlmaWVycyB0byBjb3B5LlxuICogQHBhcmFtIHtPYmplY3R9IFtvYmplY3Q9e31dIFRoZSBvYmplY3QgdG8gY29weSBwcm9wZXJ0aWVzIHRvLlxuICogQHBhcmFtIHtGdW5jdGlvbn0gW2N1c3RvbWl6ZXJdIFRoZSBmdW5jdGlvbiB0byBjdXN0b21pemUgY29waWVkIHZhbHVlcy5cbiAqIEByZXR1cm5zIHtPYmplY3R9IFJldHVybnMgYG9iamVjdGAuXG4gKi9cbmZ1bmN0aW9uIGNvcHlPYmplY3Qoc291cmNlLCBwcm9wcywgb2JqZWN0LCBjdXN0b21pemVyKSB7XG4gIG9iamVjdCB8fCAob2JqZWN0ID0ge30pO1xuXG4gIHZhciBpbmRleCA9IC0xLFxuICAgICAgbGVuZ3RoID0gcHJvcHMubGVuZ3RoO1xuXG4gIHdoaWxlICgrK2luZGV4IDwgbGVuZ3RoKSB7XG4gICAgdmFyIGtleSA9IHByb3BzW2luZGV4XTtcblxuICAgIHZhciBuZXdWYWx1ZSA9IGN1c3RvbWl6ZXJcbiAgICAgID8gY3VzdG9taXplcihvYmplY3Rba2V5XSwgc291cmNlW2tleV0sIGtleSwgb2JqZWN0LCBzb3VyY2UpXG4gICAgICA6IHNvdXJjZVtrZXldO1xuXG4gICAgYXNzaWduVmFsdWUob2JqZWN0LCBrZXksIG5ld1ZhbHVlKTtcbiAgfVxuICByZXR1cm4gb2JqZWN0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGNvcHlPYmplY3Q7XG4iLCJ2YXIgaXNJdGVyYXRlZUNhbGwgPSByZXF1aXJlKCcuL19pc0l0ZXJhdGVlQ2FsbCcpLFxuICAgIHJlc3QgPSByZXF1aXJlKCcuL3Jlc3QnKTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgZnVuY3Rpb24gbGlrZSBgXy5hc3NpZ25gLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBhc3NpZ25lciBUaGUgZnVuY3Rpb24gdG8gYXNzaWduIHZhbHVlcy5cbiAqIEByZXR1cm5zIHtGdW5jdGlvbn0gUmV0dXJucyB0aGUgbmV3IGFzc2lnbmVyIGZ1bmN0aW9uLlxuICovXG5mdW5jdGlvbiBjcmVhdGVBc3NpZ25lcihhc3NpZ25lcikge1xuICByZXR1cm4gcmVzdChmdW5jdGlvbihvYmplY3QsIHNvdXJjZXMpIHtcbiAgICB2YXIgaW5kZXggPSAtMSxcbiAgICAgICAgbGVuZ3RoID0gc291cmNlcy5sZW5ndGgsXG4gICAgICAgIGN1c3RvbWl6ZXIgPSBsZW5ndGggPiAxID8gc291cmNlc1tsZW5ndGggLSAxXSA6IHVuZGVmaW5lZCxcbiAgICAgICAgZ3VhcmQgPSBsZW5ndGggPiAyID8gc291cmNlc1syXSA6IHVuZGVmaW5lZDtcblxuICAgIGN1c3RvbWl6ZXIgPSB0eXBlb2YgY3VzdG9taXplciA9PSAnZnVuY3Rpb24nXG4gICAgICA/IChsZW5ndGgtLSwgY3VzdG9taXplcilcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgaWYgKGd1YXJkICYmIGlzSXRlcmF0ZWVDYWxsKHNvdXJjZXNbMF0sIHNvdXJjZXNbMV0sIGd1YXJkKSkge1xuICAgICAgY3VzdG9taXplciA9IGxlbmd0aCA8IDMgPyB1bmRlZmluZWQgOiBjdXN0b21pemVyO1xuICAgICAgbGVuZ3RoID0gMTtcbiAgICB9XG4gICAgb2JqZWN0ID0gT2JqZWN0KG9iamVjdCk7XG4gICAgd2hpbGUgKCsraW5kZXggPCBsZW5ndGgpIHtcbiAgICAgIHZhciBzb3VyY2UgPSBzb3VyY2VzW2luZGV4XTtcbiAgICAgIGlmIChzb3VyY2UpIHtcbiAgICAgICAgYXNzaWduZXIob2JqZWN0LCBzb3VyY2UsIGluZGV4LCBjdXN0b21pemVyKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY3JlYXRlQXNzaWduZXI7XG4iLCJ2YXIgYmFzZVRpbWVzID0gcmVxdWlyZSgnLi9fYmFzZVRpbWVzJyksXG4gICAgaXNBcmd1bWVudHMgPSByZXF1aXJlKCcuL2lzQXJndW1lbnRzJyksXG4gICAgaXNBcnJheSA9IHJlcXVpcmUoJy4vaXNBcnJheScpLFxuICAgIGlzTGVuZ3RoID0gcmVxdWlyZSgnLi9pc0xlbmd0aCcpLFxuICAgIGlzU3RyaW5nID0gcmVxdWlyZSgnLi9pc1N0cmluZycpO1xuXG4vKipcbiAqIENyZWF0ZXMgYW4gYXJyYXkgb2YgaW5kZXgga2V5cyBmb3IgYG9iamVjdGAgdmFsdWVzIG9mIGFycmF5cyxcbiAqIGBhcmd1bWVudHNgIG9iamVjdHMsIGFuZCBzdHJpbmdzLCBvdGhlcndpc2UgYG51bGxgIGlzIHJldHVybmVkLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gb2JqZWN0IFRoZSBvYmplY3QgdG8gcXVlcnkuXG4gKiBAcmV0dXJucyB7QXJyYXl8bnVsbH0gUmV0dXJucyBpbmRleCBrZXlzLCBlbHNlIGBudWxsYC5cbiAqL1xuZnVuY3Rpb24gaW5kZXhLZXlzKG9iamVjdCkge1xuICB2YXIgbGVuZ3RoID0gb2JqZWN0ID8gb2JqZWN0Lmxlbmd0aCA6IHVuZGVmaW5lZDtcbiAgaWYgKGlzTGVuZ3RoKGxlbmd0aCkgJiZcbiAgICAgIChpc0FycmF5KG9iamVjdCkgfHwgaXNTdHJpbmcob2JqZWN0KSB8fCBpc0FyZ3VtZW50cyhvYmplY3QpKSkge1xuICAgIHJldHVybiBiYXNlVGltZXMobGVuZ3RoLCBTdHJpbmcpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGluZGV4S2V5cztcbiIsInZhciBpc0FyZ3VtZW50cyA9IHJlcXVpcmUoJy4vaXNBcmd1bWVudHMnKSxcbiAgICBpc0FycmF5ID0gcmVxdWlyZSgnLi9pc0FycmF5JyksXG4gICAgaXNBcnJheUxpa2VPYmplY3QgPSByZXF1aXJlKCcuL2lzQXJyYXlMaWtlT2JqZWN0Jyk7XG5cbi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgYSBmbGF0dGVuYWJsZSBgYXJndW1lbnRzYCBvYmplY3Qgb3IgYXJyYXkuXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgZmxhdHRlbmFibGUsIGVsc2UgYGZhbHNlYC5cbiAqL1xuZnVuY3Rpb24gaXNGbGF0dGVuYWJsZSh2YWx1ZSkge1xuICByZXR1cm4gaXNBcnJheUxpa2VPYmplY3QodmFsdWUpICYmIChpc0FycmF5KHZhbHVlKSB8fCBpc0FyZ3VtZW50cyh2YWx1ZSkpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzRmxhdHRlbmFibGU7XG4iLCIvKiogVXNlZCBhcyByZWZlcmVuY2VzIGZvciB2YXJpb3VzIGBOdW1iZXJgIGNvbnN0YW50cy4gKi9cbnZhciBNQVhfU0FGRV9JTlRFR0VSID0gOTAwNzE5OTI1NDc0MDk5MTtcblxuLyoqIFVzZWQgdG8gZGV0ZWN0IHVuc2lnbmVkIGludGVnZXIgdmFsdWVzLiAqL1xudmFyIHJlSXNVaW50ID0gL14oPzowfFsxLTldXFxkKikkLztcblxuLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBhIHZhbGlkIGFycmF5LWxpa2UgaW5kZXguXG4gKlxuICogQHByaXZhdGVcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHBhcmFtIHtudW1iZXJ9IFtsZW5ndGg9TUFYX1NBRkVfSU5URUdFUl0gVGhlIHVwcGVyIGJvdW5kcyBvZiBhIHZhbGlkIGluZGV4LlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYSB2YWxpZCBpbmRleCwgZWxzZSBgZmFsc2VgLlxuICovXG5mdW5jdGlvbiBpc0luZGV4KHZhbHVlLCBsZW5ndGgpIHtcbiAgdmFsdWUgPSAodHlwZW9mIHZhbHVlID09ICdudW1iZXInIHx8IHJlSXNVaW50LnRlc3QodmFsdWUpKSA/ICt2YWx1ZSA6IC0xO1xuICBsZW5ndGggPSBsZW5ndGggPT0gbnVsbCA/IE1BWF9TQUZFX0lOVEVHRVIgOiBsZW5ndGg7XG4gIHJldHVybiB2YWx1ZSA+IC0xICYmIHZhbHVlICUgMSA9PSAwICYmIHZhbHVlIDwgbGVuZ3RoO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzSW5kZXg7XG4iLCJ2YXIgZXEgPSByZXF1aXJlKCcuL2VxJyksXG4gICAgaXNBcnJheUxpa2UgPSByZXF1aXJlKCcuL2lzQXJyYXlMaWtlJyksXG4gICAgaXNJbmRleCA9IHJlcXVpcmUoJy4vX2lzSW5kZXgnKSxcbiAgICBpc09iamVjdCA9IHJlcXVpcmUoJy4vaXNPYmplY3QnKTtcblxuLyoqXG4gKiBDaGVja3MgaWYgdGhlIGdpdmVuIGFyZ3VtZW50cyBhcmUgZnJvbSBhbiBpdGVyYXRlZSBjYWxsLlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSBwb3RlbnRpYWwgaXRlcmF0ZWUgdmFsdWUgYXJndW1lbnQuXG4gKiBAcGFyYW0geyp9IGluZGV4IFRoZSBwb3RlbnRpYWwgaXRlcmF0ZWUgaW5kZXggb3Iga2V5IGFyZ3VtZW50LlxuICogQHBhcmFtIHsqfSBvYmplY3QgVGhlIHBvdGVudGlhbCBpdGVyYXRlZSBvYmplY3QgYXJndW1lbnQuXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgdGhlIGFyZ3VtZW50cyBhcmUgZnJvbSBhbiBpdGVyYXRlZSBjYWxsLFxuICogIGVsc2UgYGZhbHNlYC5cbiAqL1xuZnVuY3Rpb24gaXNJdGVyYXRlZUNhbGwodmFsdWUsIGluZGV4LCBvYmplY3QpIHtcbiAgaWYgKCFpc09iamVjdChvYmplY3QpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHZhciB0eXBlID0gdHlwZW9mIGluZGV4O1xuICBpZiAodHlwZSA9PSAnbnVtYmVyJ1xuICAgICAgICA/IChpc0FycmF5TGlrZShvYmplY3QpICYmIGlzSW5kZXgoaW5kZXgsIG9iamVjdC5sZW5ndGgpKVxuICAgICAgICA6ICh0eXBlID09ICdzdHJpbmcnICYmIGluZGV4IGluIG9iamVjdClcbiAgICAgICkge1xuICAgIHJldHVybiBlcShvYmplY3RbaW5kZXhdLCB2YWx1ZSk7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzSXRlcmF0ZWVDYWxsO1xuIiwiLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBsaWtlbHkgYSBwcm90b3R5cGUgb2JqZWN0LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0geyp9IHZhbHVlIFRoZSB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIHtib29sZWFufSBSZXR1cm5zIGB0cnVlYCBpZiBgdmFsdWVgIGlzIGEgcHJvdG90eXBlLCBlbHNlIGBmYWxzZWAuXG4gKi9cbmZ1bmN0aW9uIGlzUHJvdG90eXBlKHZhbHVlKSB7XG4gIHZhciBDdG9yID0gdmFsdWUgJiYgdmFsdWUuY29uc3RydWN0b3IsXG4gICAgICBwcm90byA9ICh0eXBlb2YgQ3RvciA9PSAnZnVuY3Rpb24nICYmIEN0b3IucHJvdG90eXBlKSB8fCBvYmplY3RQcm90bztcblxuICByZXR1cm4gdmFsdWUgPT09IHByb3RvO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGlzUHJvdG90eXBlO1xuIiwiLyoqXG4gKiBDb252ZXJ0cyBgaXRlcmF0b3JgIHRvIGFuIGFycmF5LlxuICpcbiAqIEBwcml2YXRlXG4gKiBAcGFyYW0ge09iamVjdH0gaXRlcmF0b3IgVGhlIGl0ZXJhdG9yIHRvIGNvbnZlcnQuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIGNvbnZlcnRlZCBhcnJheS5cbiAqL1xuZnVuY3Rpb24gaXRlcmF0b3JUb0FycmF5KGl0ZXJhdG9yKSB7XG4gIHZhciBkYXRhLFxuICAgICAgcmVzdWx0ID0gW107XG5cbiAgd2hpbGUgKCEoZGF0YSA9IGl0ZXJhdG9yLm5leHQoKSkuZG9uZSkge1xuICAgIHJlc3VsdC5wdXNoKGRhdGEudmFsdWUpO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXRlcmF0b3JUb0FycmF5O1xuIiwidmFyIGNoZWNrR2xvYmFsID0gcmVxdWlyZSgnLi9fY2hlY2tHbG9iYWwnKTtcblxuLyoqIFVzZWQgdG8gZGV0ZXJtaW5lIGlmIHZhbHVlcyBhcmUgb2YgdGhlIGxhbmd1YWdlIHR5cGUgYE9iamVjdGAuICovXG52YXIgb2JqZWN0VHlwZXMgPSB7XG4gICdmdW5jdGlvbic6IHRydWUsXG4gICdvYmplY3QnOiB0cnVlXG59O1xuXG4vKiogRGV0ZWN0IGZyZWUgdmFyaWFibGUgYGV4cG9ydHNgLiAqL1xudmFyIGZyZWVFeHBvcnRzID0gKG9iamVjdFR5cGVzW3R5cGVvZiBleHBvcnRzXSAmJiBleHBvcnRzICYmICFleHBvcnRzLm5vZGVUeXBlKVxuICA/IGV4cG9ydHNcbiAgOiB1bmRlZmluZWQ7XG5cbi8qKiBEZXRlY3QgZnJlZSB2YXJpYWJsZSBgbW9kdWxlYC4gKi9cbnZhciBmcmVlTW9kdWxlID0gKG9iamVjdFR5cGVzW3R5cGVvZiBtb2R1bGVdICYmIG1vZHVsZSAmJiAhbW9kdWxlLm5vZGVUeXBlKVxuICA/IG1vZHVsZVxuICA6IHVuZGVmaW5lZDtcblxuLyoqIERldGVjdCBmcmVlIHZhcmlhYmxlIGBnbG9iYWxgIGZyb20gTm9kZS5qcy4gKi9cbnZhciBmcmVlR2xvYmFsID0gY2hlY2tHbG9iYWwoZnJlZUV4cG9ydHMgJiYgZnJlZU1vZHVsZSAmJiB0eXBlb2YgZ2xvYmFsID09ICdvYmplY3QnICYmIGdsb2JhbCk7XG5cbi8qKiBEZXRlY3QgZnJlZSB2YXJpYWJsZSBgc2VsZmAuICovXG52YXIgZnJlZVNlbGYgPSBjaGVja0dsb2JhbChvYmplY3RUeXBlc1t0eXBlb2Ygc2VsZl0gJiYgc2VsZik7XG5cbi8qKiBEZXRlY3QgZnJlZSB2YXJpYWJsZSBgd2luZG93YC4gKi9cbnZhciBmcmVlV2luZG93ID0gY2hlY2tHbG9iYWwob2JqZWN0VHlwZXNbdHlwZW9mIHdpbmRvd10gJiYgd2luZG93KTtcblxuLyoqIERldGVjdCBgdGhpc2AgYXMgdGhlIGdsb2JhbCBvYmplY3QuICovXG52YXIgdGhpc0dsb2JhbCA9IGNoZWNrR2xvYmFsKG9iamVjdFR5cGVzW3R5cGVvZiB0aGlzXSAmJiB0aGlzKTtcblxuLyoqXG4gKiBVc2VkIGFzIGEgcmVmZXJlbmNlIHRvIHRoZSBnbG9iYWwgb2JqZWN0LlxuICpcbiAqIFRoZSBgdGhpc2AgdmFsdWUgaXMgdXNlZCBpZiBpdCdzIHRoZSBnbG9iYWwgb2JqZWN0IHRvIGF2b2lkIEdyZWFzZW1vbmtleSdzXG4gKiByZXN0cmljdGVkIGB3aW5kb3dgIG9iamVjdCwgb3RoZXJ3aXNlIHRoZSBgd2luZG93YCBvYmplY3QgaXMgdXNlZC5cbiAqL1xudmFyIHJvb3QgPSBmcmVlR2xvYmFsIHx8XG4gICgoZnJlZVdpbmRvdyAhPT0gKHRoaXNHbG9iYWwgJiYgdGhpc0dsb2JhbC53aW5kb3cpKSAmJiBmcmVlV2luZG93KSB8fFxuICAgIGZyZWVTZWxmIHx8IHRoaXNHbG9iYWwgfHwgRnVuY3Rpb24oJ3JldHVybiB0aGlzJykoKTtcblxubW9kdWxlLmV4cG9ydHMgPSByb290O1xuIiwidmFyIGNvcHlPYmplY3QgPSByZXF1aXJlKCcuL19jb3B5T2JqZWN0JyksXG4gICAgY3JlYXRlQXNzaWduZXIgPSByZXF1aXJlKCcuL19jcmVhdGVBc3NpZ25lcicpLFxuICAgIGtleXNJbiA9IHJlcXVpcmUoJy4va2V5c0luJyk7XG5cbi8qKlxuICogVGhpcyBtZXRob2QgaXMgbGlrZSBgXy5hc3NpZ25JbmAgZXhjZXB0IHRoYXQgaXQgYWNjZXB0cyBgY3VzdG9taXplcmBcbiAqIHdoaWNoIGlzIGludm9rZWQgdG8gcHJvZHVjZSB0aGUgYXNzaWduZWQgdmFsdWVzLiBJZiBgY3VzdG9taXplcmAgcmV0dXJuc1xuICogYHVuZGVmaW5lZGAsIGFzc2lnbm1lbnQgaXMgaGFuZGxlZCBieSB0aGUgbWV0aG9kIGluc3RlYWQuIFRoZSBgY3VzdG9taXplcmBcbiAqIGlzIGludm9rZWQgd2l0aCBmaXZlIGFyZ3VtZW50czogKG9ialZhbHVlLCBzcmNWYWx1ZSwga2V5LCBvYmplY3QsIHNvdXJjZSkuXG4gKlxuICogKipOb3RlOioqIFRoaXMgbWV0aG9kIG11dGF0ZXMgYG9iamVjdGAuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSA0LjAuMFxuICogQGFsaWFzIGV4dGVuZFdpdGhcbiAqIEBjYXRlZ29yeSBPYmplY3RcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIGRlc3RpbmF0aW9uIG9iamVjdC5cbiAqIEBwYXJhbSB7Li4uT2JqZWN0fSBzb3VyY2VzIFRoZSBzb3VyY2Ugb2JqZWN0cy5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IFtjdXN0b21pemVyXSBUaGUgZnVuY3Rpb24gdG8gY3VzdG9taXplIGFzc2lnbmVkIHZhbHVlcy5cbiAqIEByZXR1cm5zIHtPYmplY3R9IFJldHVybnMgYG9iamVjdGAuXG4gKiBAZXhhbXBsZVxuICpcbiAqIGZ1bmN0aW9uIGN1c3RvbWl6ZXIob2JqVmFsdWUsIHNyY1ZhbHVlKSB7XG4gKiAgIHJldHVybiBfLmlzVW5kZWZpbmVkKG9ialZhbHVlKSA/IHNyY1ZhbHVlIDogb2JqVmFsdWU7XG4gKiB9XG4gKlxuICogdmFyIGRlZmF1bHRzID0gXy5wYXJ0aWFsUmlnaHQoXy5hc3NpZ25JbldpdGgsIGN1c3RvbWl6ZXIpO1xuICpcbiAqIGRlZmF1bHRzKHsgJ2EnOiAxIH0sIHsgJ2InOiAyIH0sIHsgJ2EnOiAzIH0pO1xuICogLy8gPT4geyAnYSc6IDEsICdiJzogMiB9XG4gKi9cbnZhciBhc3NpZ25JbldpdGggPSBjcmVhdGVBc3NpZ25lcihmdW5jdGlvbihvYmplY3QsIHNvdXJjZSwgc3JjSW5kZXgsIGN1c3RvbWl6ZXIpIHtcbiAgY29weU9iamVjdChzb3VyY2UsIGtleXNJbihzb3VyY2UpLCBvYmplY3QsIGN1c3RvbWl6ZXIpO1xufSk7XG5cbm1vZHVsZS5leHBvcnRzID0gYXNzaWduSW5XaXRoO1xuIiwidmFyIGFwcGx5ID0gcmVxdWlyZSgnLi9fYXBwbHknKSxcbiAgICBhc3NpZ25JbkRlZmF1bHRzID0gcmVxdWlyZSgnLi9fYXNzaWduSW5EZWZhdWx0cycpLFxuICAgIGFzc2lnbkluV2l0aCA9IHJlcXVpcmUoJy4vYXNzaWduSW5XaXRoJyksXG4gICAgcmVzdCA9IHJlcXVpcmUoJy4vcmVzdCcpO1xuXG4vKipcbiAqIEFzc2lnbnMgb3duIGFuZCBpbmhlcml0ZWQgZW51bWVyYWJsZSBzdHJpbmcga2V5ZWQgcHJvcGVydGllcyBvZiBzb3VyY2VcbiAqIG9iamVjdHMgdG8gdGhlIGRlc3RpbmF0aW9uIG9iamVjdCBmb3IgYWxsIGRlc3RpbmF0aW9uIHByb3BlcnRpZXMgdGhhdFxuICogcmVzb2x2ZSB0byBgdW5kZWZpbmVkYC4gU291cmNlIG9iamVjdHMgYXJlIGFwcGxpZWQgZnJvbSBsZWZ0IHRvIHJpZ2h0LlxuICogT25jZSBhIHByb3BlcnR5IGlzIHNldCwgYWRkaXRpb25hbCB2YWx1ZXMgb2YgdGhlIHNhbWUgcHJvcGVydHkgYXJlIGlnbm9yZWQuXG4gKlxuICogKipOb3RlOioqIFRoaXMgbWV0aG9kIG11dGF0ZXMgYG9iamVjdGAuXG4gKlxuICogQHN0YXRpY1xuICogQHNpbmNlIDAuMS4wXG4gKiBAbWVtYmVyT2YgX1xuICogQGNhdGVnb3J5IE9iamVjdFxuICogQHBhcmFtIHtPYmplY3R9IG9iamVjdCBUaGUgZGVzdGluYXRpb24gb2JqZWN0LlxuICogQHBhcmFtIHsuLi5PYmplY3R9IFtzb3VyY2VzXSBUaGUgc291cmNlIG9iamVjdHMuXG4gKiBAcmV0dXJucyB7T2JqZWN0fSBSZXR1cm5zIGBvYmplY3RgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBfLmRlZmF1bHRzKHsgJ3VzZXInOiAnYmFybmV5JyB9LCB7ICdhZ2UnOiAzNiB9LCB7ICd1c2VyJzogJ2ZyZWQnIH0pO1xuICogLy8gPT4geyAndXNlcic6ICdiYXJuZXknLCAnYWdlJzogMzYgfVxuICovXG52YXIgZGVmYXVsdHMgPSByZXN0KGZ1bmN0aW9uKGFyZ3MpIHtcbiAgYXJncy5wdXNoKHVuZGVmaW5lZCwgYXNzaWduSW5EZWZhdWx0cyk7XG4gIHJldHVybiBhcHBseShhc3NpZ25JbldpdGgsIHVuZGVmaW5lZCwgYXJncyk7XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBkZWZhdWx0cztcbiIsInZhciBpc0FycmF5TGlrZU9iamVjdCA9IHJlcXVpcmUoJy4vaXNBcnJheUxpa2VPYmplY3QnKTtcblxuLyoqIGBPYmplY3QjdG9TdHJpbmdgIHJlc3VsdCByZWZlcmVuY2VzLiAqL1xudmFyIGFyZ3NUYWcgPSAnW29iamVjdCBBcmd1bWVudHNdJztcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqIFVzZWQgdG8gY2hlY2sgb2JqZWN0cyBmb3Igb3duIHByb3BlcnRpZXMuICovXG52YXIgaGFzT3duUHJvcGVydHkgPSBvYmplY3RQcm90by5oYXNPd25Qcm9wZXJ0eTtcblxuLyoqXG4gKiBVc2VkIHRvIHJlc29sdmUgdGhlXG4gKiBbYHRvU3RyaW5nVGFnYF0oaHR0cDovL2VjbWEtaW50ZXJuYXRpb25hbC5vcmcvZWNtYS0yNjIvNi4wLyNzZWMtb2JqZWN0LnByb3RvdHlwZS50b3N0cmluZylcbiAqIG9mIHZhbHVlcy5cbiAqL1xudmFyIG9iamVjdFRvU3RyaW5nID0gb2JqZWN0UHJvdG8udG9TdHJpbmc7XG5cbi8qKiBCdWlsdC1pbiB2YWx1ZSByZWZlcmVuY2VzLiAqL1xudmFyIHByb3BlcnR5SXNFbnVtZXJhYmxlID0gb2JqZWN0UHJvdG8ucHJvcGVydHlJc0VudW1lcmFibGU7XG5cbi8qKlxuICogQ2hlY2tzIGlmIGB2YWx1ZWAgaXMgbGlrZWx5IGFuIGBhcmd1bWVudHNgIG9iamVjdC5cbiAqXG4gKiBAc3RhdGljXG4gKiBAbWVtYmVyT2YgX1xuICogQHNpbmNlIDAuMS4wXG4gKiBAY2F0ZWdvcnkgTGFuZ1xuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gY2hlY2suXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHZhbHVlYCBpcyBjb3JyZWN0bHkgY2xhc3NpZmllZCxcbiAqICBlbHNlIGBmYWxzZWAuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8uaXNBcmd1bWVudHMoZnVuY3Rpb24oKSB7IHJldHVybiBhcmd1bWVudHM7IH0oKSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc0FyZ3VtZW50cyhbMSwgMiwgM10pO1xuICogLy8gPT4gZmFsc2VcbiAqL1xuZnVuY3Rpb24gaXNBcmd1bWVudHModmFsdWUpIHtcbiAgLy8gU2FmYXJpIDguMSBpbmNvcnJlY3RseSBtYWtlcyBgYXJndW1lbnRzLmNhbGxlZWAgZW51bWVyYWJsZSBpbiBzdHJpY3QgbW9kZS5cbiAgcmV0dXJuIGlzQXJyYXlMaWtlT2JqZWN0KHZhbHVlKSAmJiBoYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCAnY2FsbGVlJykgJiZcbiAgICAoIXByb3BlcnR5SXNFbnVtZXJhYmxlLmNhbGwodmFsdWUsICdjYWxsZWUnKSB8fCBvYmplY3RUb1N0cmluZy5jYWxsKHZhbHVlKSA9PSBhcmdzVGFnKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBpc0FyZ3VtZW50cztcbiIsInZhciBpc0FycmF5ID0gcmVxdWlyZSgnLi9pc0FycmF5JyksXG4gICAgaXNPYmplY3RMaWtlID0gcmVxdWlyZSgnLi9pc09iamVjdExpa2UnKTtcblxuLyoqIGBPYmplY3QjdG9TdHJpbmdgIHJlc3VsdCByZWZlcmVuY2VzLiAqL1xudmFyIHN0cmluZ1RhZyA9ICdbb2JqZWN0IFN0cmluZ10nO1xuXG4vKiogVXNlZCBmb3IgYnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMuICovXG52YXIgb2JqZWN0UHJvdG8gPSBPYmplY3QucHJvdG90eXBlO1xuXG4vKipcbiAqIFVzZWQgdG8gcmVzb2x2ZSB0aGVcbiAqIFtgdG9TdHJpbmdUYWdgXShodHRwOi8vZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy1vYmplY3QucHJvdG90eXBlLnRvc3RyaW5nKVxuICogb2YgdmFsdWVzLlxuICovXG52YXIgb2JqZWN0VG9TdHJpbmcgPSBvYmplY3RQcm90by50b1N0cmluZztcblxuLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBjbGFzc2lmaWVkIGFzIGEgYFN0cmluZ2AgcHJpbWl0aXZlIG9yIG9iamVjdC5cbiAqXG4gKiBAc3RhdGljXG4gKiBAc2luY2UgMC4xLjBcbiAqIEBtZW1iZXJPZiBfXG4gKiBAY2F0ZWdvcnkgTGFuZ1xuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gY2hlY2suXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJucyBgdHJ1ZWAgaWYgYHZhbHVlYCBpcyBjb3JyZWN0bHkgY2xhc3NpZmllZCxcbiAqICBlbHNlIGBmYWxzZWAuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8uaXNTdHJpbmcoJ2FiYycpO1xuICogLy8gPT4gdHJ1ZVxuICpcbiAqIF8uaXNTdHJpbmcoMSk7XG4gKiAvLyA9PiBmYWxzZVxuICovXG5mdW5jdGlvbiBpc1N0cmluZyh2YWx1ZSkge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09ICdzdHJpbmcnIHx8XG4gICAgKCFpc0FycmF5KHZhbHVlKSAmJiBpc09iamVjdExpa2UodmFsdWUpICYmIG9iamVjdFRvU3RyaW5nLmNhbGwodmFsdWUpID09IHN0cmluZ1RhZyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNTdHJpbmc7XG4iLCJ2YXIgYmFzZUtleXNJbiA9IHJlcXVpcmUoJy4vX2Jhc2VLZXlzSW4nKSxcbiAgICBpbmRleEtleXMgPSByZXF1aXJlKCcuL19pbmRleEtleXMnKSxcbiAgICBpc0luZGV4ID0gcmVxdWlyZSgnLi9faXNJbmRleCcpLFxuICAgIGlzUHJvdG90eXBlID0gcmVxdWlyZSgnLi9faXNQcm90b3R5cGUnKTtcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqIFVzZWQgdG8gY2hlY2sgb2JqZWN0cyBmb3Igb3duIHByb3BlcnRpZXMuICovXG52YXIgaGFzT3duUHJvcGVydHkgPSBvYmplY3RQcm90by5oYXNPd25Qcm9wZXJ0eTtcblxuLyoqXG4gKiBDcmVhdGVzIGFuIGFycmF5IG9mIHRoZSBvd24gYW5kIGluaGVyaXRlZCBlbnVtZXJhYmxlIHByb3BlcnR5IG5hbWVzIG9mIGBvYmplY3RgLlxuICpcbiAqICoqTm90ZToqKiBOb24tb2JqZWN0IHZhbHVlcyBhcmUgY29lcmNlZCB0byBvYmplY3RzLlxuICpcbiAqIEBzdGF0aWNcbiAqIEBtZW1iZXJPZiBfXG4gKiBAc2luY2UgMy4wLjBcbiAqIEBjYXRlZ29yeSBPYmplY3RcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIG9iamVjdCB0byBxdWVyeS5cbiAqIEByZXR1cm5zIHtBcnJheX0gUmV0dXJucyB0aGUgYXJyYXkgb2YgcHJvcGVydHkgbmFtZXMuXG4gKiBAZXhhbXBsZVxuICpcbiAqIGZ1bmN0aW9uIEZvbygpIHtcbiAqICAgdGhpcy5hID0gMTtcbiAqICAgdGhpcy5iID0gMjtcbiAqIH1cbiAqXG4gKiBGb28ucHJvdG90eXBlLmMgPSAzO1xuICpcbiAqIF8ua2V5c0luKG5ldyBGb28pO1xuICogLy8gPT4gWydhJywgJ2InLCAnYyddIChpdGVyYXRpb24gb3JkZXIgaXMgbm90IGd1YXJhbnRlZWQpXG4gKi9cbmZ1bmN0aW9uIGtleXNJbihvYmplY3QpIHtcbiAgdmFyIGluZGV4ID0gLTEsXG4gICAgICBpc1Byb3RvID0gaXNQcm90b3R5cGUob2JqZWN0KSxcbiAgICAgIHByb3BzID0gYmFzZUtleXNJbihvYmplY3QpLFxuICAgICAgcHJvcHNMZW5ndGggPSBwcm9wcy5sZW5ndGgsXG4gICAgICBpbmRleGVzID0gaW5kZXhLZXlzKG9iamVjdCksXG4gICAgICBza2lwSW5kZXhlcyA9ICEhaW5kZXhlcyxcbiAgICAgIHJlc3VsdCA9IGluZGV4ZXMgfHwgW10sXG4gICAgICBsZW5ndGggPSByZXN1bHQubGVuZ3RoO1xuXG4gIHdoaWxlICgrK2luZGV4IDwgcHJvcHNMZW5ndGgpIHtcbiAgICB2YXIga2V5ID0gcHJvcHNbaW5kZXhdO1xuICAgIGlmICghKHNraXBJbmRleGVzICYmIChrZXkgPT0gJ2xlbmd0aCcgfHwgaXNJbmRleChrZXksIGxlbmd0aCkpKSAmJlxuICAgICAgICAhKGtleSA9PSAnY29uc3RydWN0b3InICYmIChpc1Byb3RvIHx8ICFoYXNPd25Qcm9wZXJ0eS5jYWxsKG9iamVjdCwga2V5KSkpKSB7XG4gICAgICByZXN1bHQucHVzaChrZXkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGtleXNJbjtcbiIsInZhciBNYXBDYWNoZSA9IHJlcXVpcmUoJy4vX01hcENhY2hlJyk7XG5cbi8qKiBVc2VkIGFzIHRoZSBgVHlwZUVycm9yYCBtZXNzYWdlIGZvciBcIkZ1bmN0aW9uc1wiIG1ldGhvZHMuICovXG52YXIgRlVOQ19FUlJPUl9URVhUID0gJ0V4cGVjdGVkIGEgZnVuY3Rpb24nO1xuXG4vKipcbiAqIENyZWF0ZXMgYSBmdW5jdGlvbiB0aGF0IG1lbW9pemVzIHRoZSByZXN1bHQgb2YgYGZ1bmNgLiBJZiBgcmVzb2x2ZXJgIGlzXG4gKiBwcm92aWRlZCwgaXQgZGV0ZXJtaW5lcyB0aGUgY2FjaGUga2V5IGZvciBzdG9yaW5nIHRoZSByZXN1bHQgYmFzZWQgb24gdGhlXG4gKiBhcmd1bWVudHMgcHJvdmlkZWQgdG8gdGhlIG1lbW9pemVkIGZ1bmN0aW9uLiBCeSBkZWZhdWx0LCB0aGUgZmlyc3QgYXJndW1lbnRcbiAqIHByb3ZpZGVkIHRvIHRoZSBtZW1vaXplZCBmdW5jdGlvbiBpcyB1c2VkIGFzIHRoZSBtYXAgY2FjaGUga2V5LiBUaGUgYGZ1bmNgXG4gKiBpcyBpbnZva2VkIHdpdGggdGhlIGB0aGlzYCBiaW5kaW5nIG9mIHRoZSBtZW1vaXplZCBmdW5jdGlvbi5cbiAqXG4gKiAqKk5vdGU6KiogVGhlIGNhY2hlIGlzIGV4cG9zZWQgYXMgdGhlIGBjYWNoZWAgcHJvcGVydHkgb24gdGhlIG1lbW9pemVkXG4gKiBmdW5jdGlvbi4gSXRzIGNyZWF0aW9uIG1heSBiZSBjdXN0b21pemVkIGJ5IHJlcGxhY2luZyB0aGUgYF8ubWVtb2l6ZS5DYWNoZWBcbiAqIGNvbnN0cnVjdG9yIHdpdGggb25lIHdob3NlIGluc3RhbmNlcyBpbXBsZW1lbnQgdGhlXG4gKiBbYE1hcGBdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLXByb3BlcnRpZXMtb2YtdGhlLW1hcC1wcm90b3R5cGUtb2JqZWN0KVxuICogbWV0aG9kIGludGVyZmFjZSBvZiBgZGVsZXRlYCwgYGdldGAsIGBoYXNgLCBhbmQgYHNldGAuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAwLjEuMFxuICogQGNhdGVnb3J5IEZ1bmN0aW9uXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBmdW5jIFRoZSBmdW5jdGlvbiB0byBoYXZlIGl0cyBvdXRwdXQgbWVtb2l6ZWQuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBbcmVzb2x2ZXJdIFRoZSBmdW5jdGlvbiB0byByZXNvbHZlIHRoZSBjYWNoZSBrZXkuXG4gKiBAcmV0dXJucyB7RnVuY3Rpb259IFJldHVybnMgdGhlIG5ldyBtZW1vaXppbmcgZnVuY3Rpb24uXG4gKiBAZXhhbXBsZVxuICpcbiAqIHZhciBvYmplY3QgPSB7ICdhJzogMSwgJ2InOiAyIH07XG4gKiB2YXIgb3RoZXIgPSB7ICdjJzogMywgJ2QnOiA0IH07XG4gKlxuICogdmFyIHZhbHVlcyA9IF8ubWVtb2l6ZShfLnZhbHVlcyk7XG4gKiB2YWx1ZXMob2JqZWN0KTtcbiAqIC8vID0+IFsxLCAyXVxuICpcbiAqIHZhbHVlcyhvdGhlcik7XG4gKiAvLyA9PiBbMywgNF1cbiAqXG4gKiBvYmplY3QuYSA9IDI7XG4gKiB2YWx1ZXMob2JqZWN0KTtcbiAqIC8vID0+IFsxLCAyXVxuICpcbiAqIC8vIE1vZGlmeSB0aGUgcmVzdWx0IGNhY2hlLlxuICogdmFsdWVzLmNhY2hlLnNldChvYmplY3QsIFsnYScsICdiJ10pO1xuICogdmFsdWVzKG9iamVjdCk7XG4gKiAvLyA9PiBbJ2EnLCAnYiddXG4gKlxuICogLy8gUmVwbGFjZSBgXy5tZW1vaXplLkNhY2hlYC5cbiAqIF8ubWVtb2l6ZS5DYWNoZSA9IFdlYWtNYXA7XG4gKi9cbmZ1bmN0aW9uIG1lbW9pemUoZnVuYywgcmVzb2x2ZXIpIHtcbiAgaWYgKHR5cGVvZiBmdW5jICE9ICdmdW5jdGlvbicgfHwgKHJlc29sdmVyICYmIHR5cGVvZiByZXNvbHZlciAhPSAnZnVuY3Rpb24nKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoRlVOQ19FUlJPUl9URVhUKTtcbiAgfVxuICB2YXIgbWVtb2l6ZWQgPSBmdW5jdGlvbigpIHtcbiAgICB2YXIgYXJncyA9IGFyZ3VtZW50cyxcbiAgICAgICAga2V5ID0gcmVzb2x2ZXIgPyByZXNvbHZlci5hcHBseSh0aGlzLCBhcmdzKSA6IGFyZ3NbMF0sXG4gICAgICAgIGNhY2hlID0gbWVtb2l6ZWQuY2FjaGU7XG5cbiAgICBpZiAoY2FjaGUuaGFzKGtleSkpIHtcbiAgICAgIHJldHVybiBjYWNoZS5nZXQoa2V5KTtcbiAgICB9XG4gICAgdmFyIHJlc3VsdCA9IGZ1bmMuYXBwbHkodGhpcywgYXJncyk7XG4gICAgbWVtb2l6ZWQuY2FjaGUgPSBjYWNoZS5zZXQoa2V5LCByZXN1bHQpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG4gIG1lbW9pemVkLmNhY2hlID0gbmV3IChtZW1vaXplLkNhY2hlIHx8IE1hcENhY2hlKTtcbiAgcmV0dXJuIG1lbW9pemVkO1xufVxuXG4vLyBBc3NpZ24gY2FjaGUgdG8gYF8ubWVtb2l6ZWAuXG5tZW1vaXplLkNhY2hlID0gTWFwQ2FjaGU7XG5cbm1vZHVsZS5leHBvcnRzID0gbWVtb2l6ZTtcbiIsInZhciBiYXNlRmxhdHRlbiA9IHJlcXVpcmUoJy4vX2Jhc2VGbGF0dGVuJyksXG4gICAgYmFzZVVuaXEgPSByZXF1aXJlKCcuL19iYXNlVW5pcScpLFxuICAgIGlzQXJyYXlMaWtlT2JqZWN0ID0gcmVxdWlyZSgnLi9pc0FycmF5TGlrZU9iamVjdCcpLFxuICAgIHJlc3QgPSByZXF1aXJlKCcuL3Jlc3QnKTtcblxuLyoqXG4gKiBDcmVhdGVzIGFuIGFycmF5IG9mIHVuaXF1ZSB2YWx1ZXMsIGluIG9yZGVyLCBmcm9tIGFsbCBnaXZlbiBhcnJheXMgdXNpbmdcbiAqIFtgU2FtZVZhbHVlWmVyb2BdKGh0dHA6Ly9lY21hLWludGVybmF0aW9uYWwub3JnL2VjbWEtMjYyLzYuMC8jc2VjLXNhbWV2YWx1ZXplcm8pXG4gKiBmb3IgZXF1YWxpdHkgY29tcGFyaXNvbnMuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAwLjEuMFxuICogQGNhdGVnb3J5IEFycmF5XG4gKiBAcGFyYW0gey4uLkFycmF5fSBbYXJyYXlzXSBUaGUgYXJyYXlzIHRvIGluc3BlY3QuXG4gKiBAcmV0dXJucyB7QXJyYXl9IFJldHVybnMgdGhlIG5ldyBhcnJheSBvZiBjb21iaW5lZCB2YWx1ZXMuXG4gKiBAZXhhbXBsZVxuICpcbiAqIF8udW5pb24oWzIsIDFdLCBbNCwgMl0sIFsxLCAyXSk7XG4gKiAvLyA9PiBbMiwgMSwgNF1cbiAqL1xudmFyIHVuaW9uID0gcmVzdChmdW5jdGlvbihhcnJheXMpIHtcbiAgcmV0dXJuIGJhc2VVbmlxKGJhc2VGbGF0dGVuKGFycmF5cywgMSwgaXNBcnJheUxpa2VPYmplY3QsIHRydWUpKTtcbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHVuaW9uO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG52YXIgX2V4dGVuZHMgPSBPYmplY3QuYXNzaWduIHx8IGZ1bmN0aW9uICh0YXJnZXQpIHsgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHsgdmFyIHNvdXJjZSA9IGFyZ3VtZW50c1tpXTsgZm9yICh2YXIga2V5IGluIHNvdXJjZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHNvdXJjZSwga2V5KSkgeyB0YXJnZXRba2V5XSA9IHNvdXJjZVtrZXldOyB9IH0gfSByZXR1cm4gdGFyZ2V0OyB9O1xuXG52YXIgX3NsaWNlID0gQXJyYXkucHJvdG90eXBlLnNsaWNlO1xuXG52YXIgX2NyZWF0ZUNsYXNzID0gKGZ1bmN0aW9uICgpIHsgZnVuY3Rpb24gZGVmaW5lUHJvcGVydGllcyh0YXJnZXQsIHByb3BzKSB7IGZvciAodmFyIGkgPSAwOyBpIDwgcHJvcHMubGVuZ3RoOyBpKyspIHsgdmFyIGRlc2NyaXB0b3IgPSBwcm9wc1tpXTsgZGVzY3JpcHRvci5lbnVtZXJhYmxlID0gZGVzY3JpcHRvci5lbnVtZXJhYmxlIHx8IGZhbHNlOyBkZXNjcmlwdG9yLmNvbmZpZ3VyYWJsZSA9IHRydWU7IGlmICgndmFsdWUnIGluIGRlc2NyaXB0b3IpIGRlc2NyaXB0b3Iud3JpdGFibGUgPSB0cnVlOyBPYmplY3QuZGVmaW5lUHJvcGVydHkodGFyZ2V0LCBkZXNjcmlwdG9yLmtleSwgZGVzY3JpcHRvcik7IH0gfSByZXR1cm4gZnVuY3Rpb24gKENvbnN0cnVjdG9yLCBwcm90b1Byb3BzLCBzdGF0aWNQcm9wcykgeyBpZiAocHJvdG9Qcm9wcykgZGVmaW5lUHJvcGVydGllcyhDb25zdHJ1Y3Rvci5wcm90b3R5cGUsIHByb3RvUHJvcHMpOyBpZiAoc3RhdGljUHJvcHMpIGRlZmluZVByb3BlcnRpZXMoQ29uc3RydWN0b3IsIHN0YXRpY1Byb3BzKTsgcmV0dXJuIENvbnN0cnVjdG9yOyB9OyB9KSgpO1xuXG5leHBvcnRzWydkZWZhdWx0J10gPSBEcmFnRHJvcENvbnRleHQ7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbmZ1bmN0aW9uIF9pbmhlcml0cyhzdWJDbGFzcywgc3VwZXJDbGFzcykgeyBpZiAodHlwZW9mIHN1cGVyQ2xhc3MgIT09ICdmdW5jdGlvbicgJiYgc3VwZXJDbGFzcyAhPT0gbnVsbCkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdTdXBlciBleHByZXNzaW9uIG11c3QgZWl0aGVyIGJlIG51bGwgb3IgYSBmdW5jdGlvbiwgbm90ICcgKyB0eXBlb2Ygc3VwZXJDbGFzcyk7IH0gc3ViQ2xhc3MucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShzdXBlckNsYXNzICYmIHN1cGVyQ2xhc3MucHJvdG90eXBlLCB7IGNvbnN0cnVjdG9yOiB7IHZhbHVlOiBzdWJDbGFzcywgZW51bWVyYWJsZTogZmFsc2UsIHdyaXRhYmxlOiB0cnVlLCBjb25maWd1cmFibGU6IHRydWUgfSB9KTsgaWYgKHN1cGVyQ2xhc3MpIE9iamVjdC5zZXRQcm90b3R5cGVPZiA/IE9iamVjdC5zZXRQcm90b3R5cGVPZihzdWJDbGFzcywgc3VwZXJDbGFzcykgOiBzdWJDbGFzcy5fX3Byb3RvX18gPSBzdXBlckNsYXNzOyB9XG5cbnZhciBfcmVhY3QgPSByZXF1aXJlKCdyZWFjdCcpO1xuXG52YXIgX3JlYWN0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3JlYWN0KTtcblxudmFyIF9kbmRDb3JlID0gcmVxdWlyZSgnZG5kLWNvcmUnKTtcblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIF91dGlsc0NoZWNrRGVjb3JhdG9yQXJndW1lbnRzID0gcmVxdWlyZSgnLi91dGlscy9jaGVja0RlY29yYXRvckFyZ3VtZW50cycpO1xuXG52YXIgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfdXRpbHNDaGVja0RlY29yYXRvckFyZ3VtZW50cyk7XG5cbmZ1bmN0aW9uIERyYWdEcm9wQ29udGV4dChiYWNrZW5kT3JNb2R1bGUpIHtcbiAgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMyWydkZWZhdWx0J10uYXBwbHkodW5kZWZpbmVkLCBbJ0RyYWdEcm9wQ29udGV4dCcsICdiYWNrZW5kJ10uY29uY2F0KF9zbGljZS5jYWxsKGFyZ3VtZW50cykpKTtcblxuICAvLyBBdXRvLWRldGVjdCBFUzYgZGVmYXVsdCBleHBvcnQgZm9yIHBlb3BsZSBzdGlsbCB1c2luZyBFUzVcbiAgdmFyIGJhY2tlbmQgPSB1bmRlZmluZWQ7XG4gIGlmICh0eXBlb2YgYmFja2VuZE9yTW9kdWxlID09PSAnb2JqZWN0JyAmJiB0eXBlb2YgYmFja2VuZE9yTW9kdWxlWydkZWZhdWx0J10gPT09ICdmdW5jdGlvbicpIHtcbiAgICBiYWNrZW5kID0gYmFja2VuZE9yTW9kdWxlWydkZWZhdWx0J107XG4gIH0gZWxzZSB7XG4gICAgYmFja2VuZCA9IGJhY2tlbmRPck1vZHVsZTtcbiAgfVxuXG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGJhY2tlbmQgPT09ICdmdW5jdGlvbicsICdFeHBlY3RlZCB0aGUgYmFja2VuZCB0byBiZSBhIGZ1bmN0aW9uIG9yIGFuIEVTNiBtb2R1bGUgZXhwb3J0aW5nIGEgZGVmYXVsdCBmdW5jdGlvbi4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcmFnLWRyb3AtY29udGV4dC5odG1sJyk7XG5cbiAgdmFyIGNoaWxkQ29udGV4dCA9IHtcbiAgICBkcmFnRHJvcE1hbmFnZXI6IG5ldyBfZG5kQ29yZS5EcmFnRHJvcE1hbmFnZXIoYmFja2VuZClcbiAgfTtcblxuICByZXR1cm4gZnVuY3Rpb24gZGVjb3JhdGVDb250ZXh0KERlY29yYXRlZENvbXBvbmVudCkge1xuICAgIHZhciBkaXNwbGF5TmFtZSA9IERlY29yYXRlZENvbXBvbmVudC5kaXNwbGF5TmFtZSB8fCBEZWNvcmF0ZWRDb21wb25lbnQubmFtZSB8fCAnQ29tcG9uZW50JztcblxuICAgIHJldHVybiAoZnVuY3Rpb24gKF9Db21wb25lbnQpIHtcbiAgICAgIF9pbmhlcml0cyhEcmFnRHJvcENvbnRleHRDb250YWluZXIsIF9Db21wb25lbnQpO1xuXG4gICAgICBmdW5jdGlvbiBEcmFnRHJvcENvbnRleHRDb250YWluZXIoKSB7XG4gICAgICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBEcmFnRHJvcENvbnRleHRDb250YWluZXIpO1xuXG4gICAgICAgIF9Db21wb25lbnQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgIH1cblxuICAgICAgRHJhZ0Ryb3BDb250ZXh0Q29udGFpbmVyLnByb3RvdHlwZS5nZXREZWNvcmF0ZWRDb21wb25lbnRJbnN0YW5jZSA9IGZ1bmN0aW9uIGdldERlY29yYXRlZENvbXBvbmVudEluc3RhbmNlKCkge1xuICAgICAgICByZXR1cm4gdGhpcy5yZWZzLmNoaWxkO1xuICAgICAgfTtcblxuICAgICAgRHJhZ0Ryb3BDb250ZXh0Q29udGFpbmVyLnByb3RvdHlwZS5nZXRNYW5hZ2VyID0gZnVuY3Rpb24gZ2V0TWFuYWdlcigpIHtcbiAgICAgICAgcmV0dXJuIGNoaWxkQ29udGV4dC5kcmFnRHJvcE1hbmFnZXI7XG4gICAgICB9O1xuXG4gICAgICBEcmFnRHJvcENvbnRleHRDb250YWluZXIucHJvdG90eXBlLmdldENoaWxkQ29udGV4dCA9IGZ1bmN0aW9uIGdldENoaWxkQ29udGV4dCgpIHtcbiAgICAgICAgcmV0dXJuIGNoaWxkQ29udGV4dDtcbiAgICAgIH07XG5cbiAgICAgIERyYWdEcm9wQ29udGV4dENvbnRhaW5lci5wcm90b3R5cGUucmVuZGVyID0gZnVuY3Rpb24gcmVuZGVyKCkge1xuICAgICAgICByZXR1cm4gX3JlYWN0MlsnZGVmYXVsdCddLmNyZWF0ZUVsZW1lbnQoRGVjb3JhdGVkQ29tcG9uZW50LCBfZXh0ZW5kcyh7fSwgdGhpcy5wcm9wcywge1xuICAgICAgICAgIHJlZjogJ2NoaWxkJyB9KSk7XG4gICAgICB9O1xuXG4gICAgICBfY3JlYXRlQ2xhc3MoRHJhZ0Ryb3BDb250ZXh0Q29udGFpbmVyLCBudWxsLCBbe1xuICAgICAgICBrZXk6ICdEZWNvcmF0ZWRDb21wb25lbnQnLFxuICAgICAgICB2YWx1ZTogRGVjb3JhdGVkQ29tcG9uZW50LFxuICAgICAgICBlbnVtZXJhYmxlOiB0cnVlXG4gICAgICB9LCB7XG4gICAgICAgIGtleTogJ2Rpc3BsYXlOYW1lJyxcbiAgICAgICAgdmFsdWU6ICdEcmFnRHJvcENvbnRleHQoJyArIGRpc3BsYXlOYW1lICsgJyknLFxuICAgICAgICBlbnVtZXJhYmxlOiB0cnVlXG4gICAgICB9LCB7XG4gICAgICAgIGtleTogJ2NoaWxkQ29udGV4dFR5cGVzJyxcbiAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICBkcmFnRHJvcE1hbmFnZXI6IF9yZWFjdC5Qcm9wVHlwZXMub2JqZWN0LmlzUmVxdWlyZWRcbiAgICAgICAgfSxcbiAgICAgICAgZW51bWVyYWJsZTogdHJ1ZVxuICAgICAgfV0pO1xuXG4gICAgICByZXR1cm4gRHJhZ0Ryb3BDb250ZXh0Q29udGFpbmVyO1xuICAgIH0pKF9yZWFjdC5Db21wb25lbnQpO1xuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbnZhciBfZXh0ZW5kcyA9IE9iamVjdC5hc3NpZ24gfHwgZnVuY3Rpb24gKHRhcmdldCkgeyBmb3IgKHZhciBpID0gMTsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykgeyB2YXIgc291cmNlID0gYXJndW1lbnRzW2ldOyBmb3IgKHZhciBrZXkgaW4gc291cmNlKSB7IGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoc291cmNlLCBrZXkpKSB7IHRhcmdldFtrZXldID0gc291cmNlW2tleV07IH0gfSB9IHJldHVybiB0YXJnZXQ7IH07XG5cbnZhciBfc2xpY2UgPSBBcnJheS5wcm90b3R5cGUuc2xpY2U7XG5cbnZhciBfY3JlYXRlQ2xhc3MgPSAoZnVuY3Rpb24gKCkgeyBmdW5jdGlvbiBkZWZpbmVQcm9wZXJ0aWVzKHRhcmdldCwgcHJvcHMpIHsgZm9yICh2YXIgaSA9IDA7IGkgPCBwcm9wcy5sZW5ndGg7IGkrKykgeyB2YXIgZGVzY3JpcHRvciA9IHByb3BzW2ldOyBkZXNjcmlwdG9yLmVudW1lcmFibGUgPSBkZXNjcmlwdG9yLmVudW1lcmFibGUgfHwgZmFsc2U7IGRlc2NyaXB0b3IuY29uZmlndXJhYmxlID0gdHJ1ZTsgaWYgKCd2YWx1ZScgaW4gZGVzY3JpcHRvcikgZGVzY3JpcHRvci53cml0YWJsZSA9IHRydWU7IE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh0YXJnZXQsIGRlc2NyaXB0b3Iua2V5LCBkZXNjcmlwdG9yKTsgfSB9IHJldHVybiBmdW5jdGlvbiAoQ29uc3RydWN0b3IsIHByb3RvUHJvcHMsIHN0YXRpY1Byb3BzKSB7IGlmIChwcm90b1Byb3BzKSBkZWZpbmVQcm9wZXJ0aWVzKENvbnN0cnVjdG9yLnByb3RvdHlwZSwgcHJvdG9Qcm9wcyk7IGlmIChzdGF0aWNQcm9wcykgZGVmaW5lUHJvcGVydGllcyhDb25zdHJ1Y3Rvciwgc3RhdGljUHJvcHMpOyByZXR1cm4gQ29uc3RydWN0b3I7IH07IH0pKCk7XG5cbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IERyYWdMYXllcjtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH1cblxuZnVuY3Rpb24gX2luaGVyaXRzKHN1YkNsYXNzLCBzdXBlckNsYXNzKSB7IGlmICh0eXBlb2Ygc3VwZXJDbGFzcyAhPT0gJ2Z1bmN0aW9uJyAmJiBzdXBlckNsYXNzICE9PSBudWxsKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ1N1cGVyIGV4cHJlc3Npb24gbXVzdCBlaXRoZXIgYmUgbnVsbCBvciBhIGZ1bmN0aW9uLCBub3QgJyArIHR5cGVvZiBzdXBlckNsYXNzKTsgfSBzdWJDbGFzcy5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ2xhc3MgJiYgc3VwZXJDbGFzcy5wcm90b3R5cGUsIHsgY29uc3RydWN0b3I6IHsgdmFsdWU6IHN1YkNsYXNzLCBlbnVtZXJhYmxlOiBmYWxzZSwgd3JpdGFibGU6IHRydWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSB9IH0pOyBpZiAoc3VwZXJDbGFzcykgT2JqZWN0LnNldFByb3RvdHlwZU9mID8gT2JqZWN0LnNldFByb3RvdHlwZU9mKHN1YkNsYXNzLCBzdXBlckNsYXNzKSA6IHN1YkNsYXNzLl9fcHJvdG9fXyA9IHN1cGVyQ2xhc3M7IH1cblxudmFyIF9yZWFjdCA9IHJlcXVpcmUoJ3JlYWN0Jyk7XG5cbnZhciBfcmVhY3QyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfcmVhY3QpO1xuXG52YXIgX3V0aWxzU2hhbGxvd0VxdWFsID0gcmVxdWlyZSgnLi91dGlscy9zaGFsbG93RXF1YWwnKTtcblxudmFyIF91dGlsc1NoYWxsb3dFcXVhbDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc1NoYWxsb3dFcXVhbCk7XG5cbnZhciBfdXRpbHNTaGFsbG93RXF1YWxTY2FsYXIgPSByZXF1aXJlKCcuL3V0aWxzL3NoYWxsb3dFcXVhbFNjYWxhcicpO1xuXG52YXIgX3V0aWxzU2hhbGxvd0VxdWFsU2NhbGFyMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3V0aWxzU2hhbGxvd0VxdWFsU2NhbGFyKTtcblxudmFyIF9sb2Rhc2hJc1BsYWluT2JqZWN0ID0gcmVxdWlyZSgnbG9kYXNoL2lzUGxhaW5PYmplY3QnKTtcblxudmFyIF9sb2Rhc2hJc1BsYWluT2JqZWN0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaElzUGxhaW5PYmplY3QpO1xuXG52YXIgX2ludmFyaWFudCA9IHJlcXVpcmUoJ2ludmFyaWFudCcpO1xuXG52YXIgX2ludmFyaWFudDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9pbnZhcmlhbnQpO1xuXG52YXIgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMgPSByZXF1aXJlKCcuL3V0aWxzL2NoZWNrRGVjb3JhdG9yQXJndW1lbnRzJyk7XG5cbnZhciBfdXRpbHNDaGVja0RlY29yYXRvckFyZ3VtZW50czIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc0NoZWNrRGVjb3JhdG9yQXJndW1lbnRzKTtcblxuZnVuY3Rpb24gRHJhZ0xheWVyKGNvbGxlY3QpIHtcbiAgdmFyIG9wdGlvbnMgPSBhcmd1bWVudHMubGVuZ3RoIDw9IDEgfHwgYXJndW1lbnRzWzFdID09PSB1bmRlZmluZWQgPyB7fSA6IGFyZ3VtZW50c1sxXTtcblxuICBfdXRpbHNDaGVja0RlY29yYXRvckFyZ3VtZW50czJbJ2RlZmF1bHQnXS5hcHBseSh1bmRlZmluZWQsIFsnRHJhZ0xheWVyJywgJ2NvbGxlY3RbLCBvcHRpb25zXSddLmNvbmNhdChfc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGNvbGxlY3QgPT09ICdmdW5jdGlvbicsICdFeHBlY3RlZCBcImNvbGxlY3RcIiBwcm92aWRlZCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgdG8gRHJhZ0xheWVyICcgKyAndG8gYmUgYSBmdW5jdGlvbiB0aGF0IGNvbGxlY3RzIHByb3BzIHRvIGluamVjdCBpbnRvIHRoZSBjb21wb25lbnQuICcsICdJbnN0ZWFkLCByZWNlaXZlZCAlcy4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcmFnLWxheWVyLmh0bWwnLCBjb2xsZWN0KTtcbiAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShfbG9kYXNoSXNQbGFpbk9iamVjdDJbJ2RlZmF1bHQnXShvcHRpb25zKSwgJ0V4cGVjdGVkIFwib3B0aW9uc1wiIHByb3ZpZGVkIGFzIHRoZSBzZWNvbmQgYXJndW1lbnQgdG8gRHJhZ0xheWVyIHRvIGJlICcgKyAnYSBwbGFpbiBvYmplY3Qgd2hlbiBzcGVjaWZpZWQuICcgKyAnSW5zdGVhZCwgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJhZy1sYXllci5odG1sJywgb3B0aW9ucyk7XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIGRlY29yYXRlTGF5ZXIoRGVjb3JhdGVkQ29tcG9uZW50KSB7XG4gICAgdmFyIF9vcHRpb25zJGFyZVByb3BzRXF1YWwgPSBvcHRpb25zLmFyZVByb3BzRXF1YWw7XG4gICAgdmFyIGFyZVByb3BzRXF1YWwgPSBfb3B0aW9ucyRhcmVQcm9wc0VxdWFsID09PSB1bmRlZmluZWQgPyBfdXRpbHNTaGFsbG93RXF1YWxTY2FsYXIyWydkZWZhdWx0J10gOiBfb3B0aW9ucyRhcmVQcm9wc0VxdWFsO1xuXG4gICAgdmFyIGRpc3BsYXlOYW1lID0gRGVjb3JhdGVkQ29tcG9uZW50LmRpc3BsYXlOYW1lIHx8IERlY29yYXRlZENvbXBvbmVudC5uYW1lIHx8ICdDb21wb25lbnQnO1xuXG4gICAgcmV0dXJuIChmdW5jdGlvbiAoX0NvbXBvbmVudCkge1xuICAgICAgX2luaGVyaXRzKERyYWdMYXllckNvbnRhaW5lciwgX0NvbXBvbmVudCk7XG5cbiAgICAgIERyYWdMYXllckNvbnRhaW5lci5wcm90b3R5cGUuZ2V0RGVjb3JhdGVkQ29tcG9uZW50SW5zdGFuY2UgPSBmdW5jdGlvbiBnZXREZWNvcmF0ZWRDb21wb25lbnRJbnN0YW5jZSgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVmcy5jaGlsZDtcbiAgICAgIH07XG5cbiAgICAgIERyYWdMYXllckNvbnRhaW5lci5wcm90b3R5cGUuc2hvdWxkQ29tcG9uZW50VXBkYXRlID0gZnVuY3Rpb24gc2hvdWxkQ29tcG9uZW50VXBkYXRlKG5leHRQcm9wcywgbmV4dFN0YXRlKSB7XG4gICAgICAgIHJldHVybiAhYXJlUHJvcHNFcXVhbChuZXh0UHJvcHMsIHRoaXMucHJvcHMpIHx8ICFfdXRpbHNTaGFsbG93RXF1YWwyWydkZWZhdWx0J10obmV4dFN0YXRlLCB0aGlzLnN0YXRlKTtcbiAgICAgIH07XG5cbiAgICAgIF9jcmVhdGVDbGFzcyhEcmFnTGF5ZXJDb250YWluZXIsIG51bGwsIFt7XG4gICAgICAgIGtleTogJ0RlY29yYXRlZENvbXBvbmVudCcsXG4gICAgICAgIHZhbHVlOiBEZWNvcmF0ZWRDb21wb25lbnQsXG4gICAgICAgIGVudW1lcmFibGU6IHRydWVcbiAgICAgIH0sIHtcbiAgICAgICAga2V5OiAnZGlzcGxheU5hbWUnLFxuICAgICAgICB2YWx1ZTogJ0RyYWdMYXllcignICsgZGlzcGxheU5hbWUgKyAnKScsXG4gICAgICAgIGVudW1lcmFibGU6IHRydWVcbiAgICAgIH0sIHtcbiAgICAgICAga2V5OiAnY29udGV4dFR5cGVzJyxcbiAgICAgICAgdmFsdWU6IHtcbiAgICAgICAgICBkcmFnRHJvcE1hbmFnZXI6IF9yZWFjdC5Qcm9wVHlwZXMub2JqZWN0LmlzUmVxdWlyZWRcbiAgICAgICAgfSxcbiAgICAgICAgZW51bWVyYWJsZTogdHJ1ZVxuICAgICAgfV0pO1xuXG4gICAgICBmdW5jdGlvbiBEcmFnTGF5ZXJDb250YWluZXIocHJvcHMsIGNvbnRleHQpIHtcbiAgICAgICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIERyYWdMYXllckNvbnRhaW5lcik7XG5cbiAgICAgICAgX0NvbXBvbmVudC5jYWxsKHRoaXMsIHByb3BzKTtcbiAgICAgICAgdGhpcy5oYW5kbGVDaGFuZ2UgPSB0aGlzLmhhbmRsZUNoYW5nZS5iaW5kKHRoaXMpO1xuXG4gICAgICAgIHRoaXMubWFuYWdlciA9IGNvbnRleHQuZHJhZ0Ryb3BNYW5hZ2VyO1xuICAgICAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiB0aGlzLm1hbmFnZXIgPT09ICdvYmplY3QnLCAnQ291bGQgbm90IGZpbmQgdGhlIGRyYWcgYW5kIGRyb3AgbWFuYWdlciBpbiB0aGUgY29udGV4dCBvZiAlcy4gJyArICdNYWtlIHN1cmUgdG8gd3JhcCB0aGUgdG9wLWxldmVsIGNvbXBvbmVudCBvZiB5b3VyIGFwcCB3aXRoIERyYWdEcm9wQ29udGV4dC4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy10cm91Ymxlc2hvb3RpbmcuaHRtbCNjb3VsZC1ub3QtZmluZC10aGUtZHJhZy1hbmQtZHJvcC1tYW5hZ2VyLWluLXRoZS1jb250ZXh0JywgZGlzcGxheU5hbWUsIGRpc3BsYXlOYW1lKTtcblxuICAgICAgICB0aGlzLnN0YXRlID0gdGhpcy5nZXRDdXJyZW50U3RhdGUoKTtcbiAgICAgIH1cblxuICAgICAgRHJhZ0xheWVyQ29udGFpbmVyLnByb3RvdHlwZS5jb21wb25lbnREaWRNb3VudCA9IGZ1bmN0aW9uIGNvbXBvbmVudERpZE1vdW50KCkge1xuICAgICAgICB0aGlzLmlzQ3VycmVudGx5TW91bnRlZCA9IHRydWU7XG5cbiAgICAgICAgdmFyIG1vbml0b3IgPSB0aGlzLm1hbmFnZXIuZ2V0TW9uaXRvcigpO1xuICAgICAgICB0aGlzLnVuc3Vic2NyaWJlRnJvbU9mZnNldENoYW5nZSA9IG1vbml0b3Iuc3Vic2NyaWJlVG9PZmZzZXRDaGFuZ2UodGhpcy5oYW5kbGVDaGFuZ2UpO1xuICAgICAgICB0aGlzLnVuc3Vic2NyaWJlRnJvbVN0YXRlQ2hhbmdlID0gbW9uaXRvci5zdWJzY3JpYmVUb1N0YXRlQ2hhbmdlKHRoaXMuaGFuZGxlQ2hhbmdlKTtcblxuICAgICAgICB0aGlzLmhhbmRsZUNoYW5nZSgpO1xuICAgICAgfTtcblxuICAgICAgRHJhZ0xheWVyQ29udGFpbmVyLnByb3RvdHlwZS5jb21wb25lbnRXaWxsVW5tb3VudCA9IGZ1bmN0aW9uIGNvbXBvbmVudFdpbGxVbm1vdW50KCkge1xuICAgICAgICB0aGlzLmlzQ3VycmVudGx5TW91bnRlZCA9IGZhbHNlO1xuXG4gICAgICAgIHRoaXMudW5zdWJzY3JpYmVGcm9tT2Zmc2V0Q2hhbmdlKCk7XG4gICAgICAgIHRoaXMudW5zdWJzY3JpYmVGcm9tU3RhdGVDaGFuZ2UoKTtcbiAgICAgIH07XG5cbiAgICAgIERyYWdMYXllckNvbnRhaW5lci5wcm90b3R5cGUuaGFuZGxlQ2hhbmdlID0gZnVuY3Rpb24gaGFuZGxlQ2hhbmdlKCkge1xuICAgICAgICBpZiAoIXRoaXMuaXNDdXJyZW50bHlNb3VudGVkKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIG5leHRTdGF0ZSA9IHRoaXMuZ2V0Q3VycmVudFN0YXRlKCk7XG4gICAgICAgIGlmICghX3V0aWxzU2hhbGxvd0VxdWFsMlsnZGVmYXVsdCddKG5leHRTdGF0ZSwgdGhpcy5zdGF0ZSkpIHtcbiAgICAgICAgICB0aGlzLnNldFN0YXRlKG5leHRTdGF0ZSk7XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIERyYWdMYXllckNvbnRhaW5lci5wcm90b3R5cGUuZ2V0Q3VycmVudFN0YXRlID0gZnVuY3Rpb24gZ2V0Q3VycmVudFN0YXRlKCkge1xuICAgICAgICB2YXIgbW9uaXRvciA9IHRoaXMubWFuYWdlci5nZXRNb25pdG9yKCk7XG4gICAgICAgIHJldHVybiBjb2xsZWN0KG1vbml0b3IpO1xuICAgICAgfTtcblxuICAgICAgRHJhZ0xheWVyQ29udGFpbmVyLnByb3RvdHlwZS5yZW5kZXIgPSBmdW5jdGlvbiByZW5kZXIoKSB7XG4gICAgICAgIHJldHVybiBfcmVhY3QyWydkZWZhdWx0J10uY3JlYXRlRWxlbWVudChEZWNvcmF0ZWRDb21wb25lbnQsIF9leHRlbmRzKHt9LCB0aGlzLnByb3BzLCB0aGlzLnN0YXRlLCB7XG4gICAgICAgICAgcmVmOiAnY2hpbGQnIH0pKTtcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiBEcmFnTGF5ZXJDb250YWluZXI7XG4gICAgfSkoX3JlYWN0LkNvbXBvbmVudCk7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbnZhciBfc2xpY2UgPSBBcnJheS5wcm90b3R5cGUuc2xpY2U7XG5leHBvcnRzWydkZWZhdWx0J10gPSBEcmFnU291cmNlO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfaW52YXJpYW50ID0gcmVxdWlyZSgnaW52YXJpYW50Jyk7XG5cbnZhciBfaW52YXJpYW50MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2ludmFyaWFudCk7XG5cbnZhciBfbG9kYXNoSXNQbGFpbk9iamVjdCA9IHJlcXVpcmUoJ2xvZGFzaC9pc1BsYWluT2JqZWN0Jyk7XG5cbnZhciBfbG9kYXNoSXNQbGFpbk9iamVjdDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hJc1BsYWluT2JqZWN0KTtcblxudmFyIF91dGlsc0NoZWNrRGVjb3JhdG9yQXJndW1lbnRzID0gcmVxdWlyZSgnLi91dGlscy9jaGVja0RlY29yYXRvckFyZ3VtZW50cycpO1xuXG52YXIgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfdXRpbHNDaGVja0RlY29yYXRvckFyZ3VtZW50cyk7XG5cbnZhciBfZGVjb3JhdGVIYW5kbGVyID0gcmVxdWlyZSgnLi9kZWNvcmF0ZUhhbmRsZXInKTtcblxudmFyIF9kZWNvcmF0ZUhhbmRsZXIyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfZGVjb3JhdGVIYW5kbGVyKTtcblxudmFyIF9yZWdpc3RlclNvdXJjZSA9IHJlcXVpcmUoJy4vcmVnaXN0ZXJTb3VyY2UnKTtcblxudmFyIF9yZWdpc3RlclNvdXJjZTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9yZWdpc3RlclNvdXJjZSk7XG5cbnZhciBfY3JlYXRlU291cmNlRmFjdG9yeSA9IHJlcXVpcmUoJy4vY3JlYXRlU291cmNlRmFjdG9yeScpO1xuXG52YXIgX2NyZWF0ZVNvdXJjZUZhY3RvcnkyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfY3JlYXRlU291cmNlRmFjdG9yeSk7XG5cbnZhciBfY3JlYXRlU291cmNlTW9uaXRvciA9IHJlcXVpcmUoJy4vY3JlYXRlU291cmNlTW9uaXRvcicpO1xuXG52YXIgX2NyZWF0ZVNvdXJjZU1vbml0b3IyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfY3JlYXRlU291cmNlTW9uaXRvcik7XG5cbnZhciBfY3JlYXRlU291cmNlQ29ubmVjdG9yID0gcmVxdWlyZSgnLi9jcmVhdGVTb3VyY2VDb25uZWN0b3InKTtcblxudmFyIF9jcmVhdGVTb3VyY2VDb25uZWN0b3IyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfY3JlYXRlU291cmNlQ29ubmVjdG9yKTtcblxudmFyIF91dGlsc0lzVmFsaWRUeXBlID0gcmVxdWlyZSgnLi91dGlscy9pc1ZhbGlkVHlwZScpO1xuXG52YXIgX3V0aWxzSXNWYWxpZFR5cGUyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfdXRpbHNJc1ZhbGlkVHlwZSk7XG5cbmZ1bmN0aW9uIERyYWdTb3VyY2UodHlwZSwgc3BlYywgY29sbGVjdCkge1xuICB2YXIgb3B0aW9ucyA9IGFyZ3VtZW50cy5sZW5ndGggPD0gMyB8fCBhcmd1bWVudHNbM10gPT09IHVuZGVmaW5lZCA/IHt9IDogYXJndW1lbnRzWzNdO1xuXG4gIF91dGlsc0NoZWNrRGVjb3JhdG9yQXJndW1lbnRzMlsnZGVmYXVsdCddLmFwcGx5KHVuZGVmaW5lZCwgWydEcmFnU291cmNlJywgJ3R5cGUsIHNwZWMsIGNvbGxlY3RbLCBvcHRpb25zXSddLmNvbmNhdChfc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7XG4gIHZhciBnZXRUeXBlID0gdHlwZTtcbiAgaWYgKHR5cGVvZiB0eXBlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShfdXRpbHNJc1ZhbGlkVHlwZTJbJ2RlZmF1bHQnXSh0eXBlKSwgJ0V4cGVjdGVkIFwidHlwZVwiIHByb3ZpZGVkIGFzIHRoZSBmaXJzdCBhcmd1bWVudCB0byBEcmFnU291cmNlIHRvIGJlICcgKyAnYSBzdHJpbmcsIG9yIGEgZnVuY3Rpb24gdGhhdCByZXR1cm5zIGEgc3RyaW5nIGdpdmVuIHRoZSBjdXJyZW50IHByb3BzLiAnICsgJ0luc3RlYWQsIHJlY2VpdmVkICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyYWctc291cmNlLmh0bWwnLCB0eXBlKTtcbiAgICBnZXRUeXBlID0gZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIHR5cGU7XG4gICAgfTtcbiAgfVxuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKHNwZWMpLCAnRXhwZWN0ZWQgXCJzcGVjXCIgcHJvdmlkZWQgYXMgdGhlIHNlY29uZCBhcmd1bWVudCB0byBEcmFnU291cmNlIHRvIGJlICcgKyAnYSBwbGFpbiBvYmplY3QuIEluc3RlYWQsIHJlY2VpdmVkICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyYWctc291cmNlLmh0bWwnLCBzcGVjKTtcbiAgdmFyIGNyZWF0ZVNvdXJjZSA9IF9jcmVhdGVTb3VyY2VGYWN0b3J5MlsnZGVmYXVsdCddKHNwZWMpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBjb2xsZWN0ID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgXCJjb2xsZWN0XCIgcHJvdmlkZWQgYXMgdGhlIHRoaXJkIGFyZ3VtZW50IHRvIERyYWdTb3VyY2UgdG8gYmUgJyArICdhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIHBsYWluIG9iamVjdCBvZiBwcm9wcyB0byBpbmplY3QuICcgKyAnSW5zdGVhZCwgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJhZy1zb3VyY2UuaHRtbCcsIGNvbGxlY3QpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKG9wdGlvbnMpLCAnRXhwZWN0ZWQgXCJvcHRpb25zXCIgcHJvdmlkZWQgYXMgdGhlIGZvdXJ0aCBhcmd1bWVudCB0byBEcmFnU291cmNlIHRvIGJlICcgKyAnYSBwbGFpbiBvYmplY3Qgd2hlbiBzcGVjaWZpZWQuICcgKyAnSW5zdGVhZCwgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJhZy1zb3VyY2UuaHRtbCcsIGNvbGxlY3QpO1xuXG4gIHJldHVybiBmdW5jdGlvbiBkZWNvcmF0ZVNvdXJjZShEZWNvcmF0ZWRDb21wb25lbnQpIHtcbiAgICByZXR1cm4gX2RlY29yYXRlSGFuZGxlcjJbJ2RlZmF1bHQnXSh7XG4gICAgICBjb25uZWN0QmFja2VuZDogZnVuY3Rpb24gY29ubmVjdEJhY2tlbmQoYmFja2VuZCwgc291cmNlSWQpIHtcbiAgICAgICAgcmV0dXJuIGJhY2tlbmQuY29ubmVjdERyYWdTb3VyY2Uoc291cmNlSWQpO1xuICAgICAgfSxcbiAgICAgIGNvbnRhaW5lckRpc3BsYXlOYW1lOiAnRHJhZ1NvdXJjZScsXG4gICAgICBjcmVhdGVIYW5kbGVyOiBjcmVhdGVTb3VyY2UsXG4gICAgICByZWdpc3RlckhhbmRsZXI6IF9yZWdpc3RlclNvdXJjZTJbJ2RlZmF1bHQnXSxcbiAgICAgIGNyZWF0ZU1vbml0b3I6IF9jcmVhdGVTb3VyY2VNb25pdG9yMlsnZGVmYXVsdCddLFxuICAgICAgY3JlYXRlQ29ubmVjdG9yOiBfY3JlYXRlU291cmNlQ29ubmVjdG9yMlsnZGVmYXVsdCddLFxuICAgICAgRGVjb3JhdGVkQ29tcG9uZW50OiBEZWNvcmF0ZWRDb21wb25lbnQsXG4gICAgICBnZXRUeXBlOiBnZXRUeXBlLFxuICAgICAgY29sbGVjdDogY29sbGVjdCxcbiAgICAgIG9wdGlvbnM6IG9wdGlvbnNcbiAgICB9KTtcbiAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xudmFyIF9zbGljZSA9IEFycmF5LnByb3RvdHlwZS5zbGljZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IERyb3BUYXJnZXQ7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIF9sb2Rhc2hJc1BsYWluT2JqZWN0ID0gcmVxdWlyZSgnbG9kYXNoL2lzUGxhaW5PYmplY3QnKTtcblxudmFyIF9sb2Rhc2hJc1BsYWluT2JqZWN0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2xvZGFzaElzUGxhaW5PYmplY3QpO1xuXG52YXIgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMgPSByZXF1aXJlKCcuL3V0aWxzL2NoZWNrRGVjb3JhdG9yQXJndW1lbnRzJyk7XG5cbnZhciBfdXRpbHNDaGVja0RlY29yYXRvckFyZ3VtZW50czIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc0NoZWNrRGVjb3JhdG9yQXJndW1lbnRzKTtcblxudmFyIF9kZWNvcmF0ZUhhbmRsZXIgPSByZXF1aXJlKCcuL2RlY29yYXRlSGFuZGxlcicpO1xuXG52YXIgX2RlY29yYXRlSGFuZGxlcjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9kZWNvcmF0ZUhhbmRsZXIpO1xuXG52YXIgX3JlZ2lzdGVyVGFyZ2V0ID0gcmVxdWlyZSgnLi9yZWdpc3RlclRhcmdldCcpO1xuXG52YXIgX3JlZ2lzdGVyVGFyZ2V0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3JlZ2lzdGVyVGFyZ2V0KTtcblxudmFyIF9jcmVhdGVUYXJnZXRGYWN0b3J5ID0gcmVxdWlyZSgnLi9jcmVhdGVUYXJnZXRGYWN0b3J5Jyk7XG5cbnZhciBfY3JlYXRlVGFyZ2V0RmFjdG9yeTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9jcmVhdGVUYXJnZXRGYWN0b3J5KTtcblxudmFyIF9jcmVhdGVUYXJnZXRNb25pdG9yID0gcmVxdWlyZSgnLi9jcmVhdGVUYXJnZXRNb25pdG9yJyk7XG5cbnZhciBfY3JlYXRlVGFyZ2V0TW9uaXRvcjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9jcmVhdGVUYXJnZXRNb25pdG9yKTtcblxudmFyIF9jcmVhdGVUYXJnZXRDb25uZWN0b3IgPSByZXF1aXJlKCcuL2NyZWF0ZVRhcmdldENvbm5lY3RvcicpO1xuXG52YXIgX2NyZWF0ZVRhcmdldENvbm5lY3RvcjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9jcmVhdGVUYXJnZXRDb25uZWN0b3IpO1xuXG52YXIgX3V0aWxzSXNWYWxpZFR5cGUgPSByZXF1aXJlKCcuL3V0aWxzL2lzVmFsaWRUeXBlJyk7XG5cbnZhciBfdXRpbHNJc1ZhbGlkVHlwZTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc0lzVmFsaWRUeXBlKTtcblxuZnVuY3Rpb24gRHJvcFRhcmdldCh0eXBlLCBzcGVjLCBjb2xsZWN0KSB7XG4gIHZhciBvcHRpb25zID0gYXJndW1lbnRzLmxlbmd0aCA8PSAzIHx8IGFyZ3VtZW50c1szXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbM107XG5cbiAgX3V0aWxzQ2hlY2tEZWNvcmF0b3JBcmd1bWVudHMyWydkZWZhdWx0J10uYXBwbHkodW5kZWZpbmVkLCBbJ0Ryb3BUYXJnZXQnLCAndHlwZSwgc3BlYywgY29sbGVjdFssIG9wdGlvbnNdJ10uY29uY2F0KF9zbGljZS5jYWxsKGFyZ3VtZW50cykpKTtcbiAgdmFyIGdldFR5cGUgPSB0eXBlO1xuICBpZiAodHlwZW9mIHR5cGUgIT09ICdmdW5jdGlvbicpIHtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF91dGlsc0lzVmFsaWRUeXBlMlsnZGVmYXVsdCddKHR5cGUsIHRydWUpLCAnRXhwZWN0ZWQgXCJ0eXBlXCIgcHJvdmlkZWQgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IHRvIERyb3BUYXJnZXQgdG8gYmUgJyArICdhIHN0cmluZywgYW4gYXJyYXkgb2Ygc3RyaW5ncywgb3IgYSBmdW5jdGlvbiB0aGF0IHJldHVybnMgZWl0aGVyIGdpdmVuICcgKyAndGhlIGN1cnJlbnQgcHJvcHMuIEluc3RlYWQsIHJlY2VpdmVkICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyb3AtdGFyZ2V0Lmh0bWwnLCB0eXBlKTtcbiAgICBnZXRUeXBlID0gZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIHR5cGU7XG4gICAgfTtcbiAgfVxuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKHNwZWMpLCAnRXhwZWN0ZWQgXCJzcGVjXCIgcHJvdmlkZWQgYXMgdGhlIHNlY29uZCBhcmd1bWVudCB0byBEcm9wVGFyZ2V0IHRvIGJlICcgKyAnYSBwbGFpbiBvYmplY3QuIEluc3RlYWQsIHJlY2VpdmVkICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyb3AtdGFyZ2V0Lmh0bWwnLCBzcGVjKTtcbiAgdmFyIGNyZWF0ZVRhcmdldCA9IF9jcmVhdGVUYXJnZXRGYWN0b3J5MlsnZGVmYXVsdCddKHNwZWMpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBjb2xsZWN0ID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgXCJjb2xsZWN0XCIgcHJvdmlkZWQgYXMgdGhlIHRoaXJkIGFyZ3VtZW50IHRvIERyb3BUYXJnZXQgdG8gYmUgJyArICdhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIHBsYWluIG9iamVjdCBvZiBwcm9wcyB0byBpbmplY3QuICcgKyAnSW5zdGVhZCwgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJvcC10YXJnZXQuaHRtbCcsIGNvbGxlY3QpO1xuICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKG9wdGlvbnMpLCAnRXhwZWN0ZWQgXCJvcHRpb25zXCIgcHJvdmlkZWQgYXMgdGhlIGZvdXJ0aCBhcmd1bWVudCB0byBEcm9wVGFyZ2V0IHRvIGJlICcgKyAnYSBwbGFpbiBvYmplY3Qgd2hlbiBzcGVjaWZpZWQuICcgKyAnSW5zdGVhZCwgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJvcC10YXJnZXQuaHRtbCcsIGNvbGxlY3QpO1xuXG4gIHJldHVybiBmdW5jdGlvbiBkZWNvcmF0ZVRhcmdldChEZWNvcmF0ZWRDb21wb25lbnQpIHtcbiAgICByZXR1cm4gX2RlY29yYXRlSGFuZGxlcjJbJ2RlZmF1bHQnXSh7XG4gICAgICBjb25uZWN0QmFja2VuZDogZnVuY3Rpb24gY29ubmVjdEJhY2tlbmQoYmFja2VuZCwgdGFyZ2V0SWQpIHtcbiAgICAgICAgcmV0dXJuIGJhY2tlbmQuY29ubmVjdERyb3BUYXJnZXQodGFyZ2V0SWQpO1xuICAgICAgfSxcbiAgICAgIGNvbnRhaW5lckRpc3BsYXlOYW1lOiAnRHJvcFRhcmdldCcsXG4gICAgICBjcmVhdGVIYW5kbGVyOiBjcmVhdGVUYXJnZXQsXG4gICAgICByZWdpc3RlckhhbmRsZXI6IF9yZWdpc3RlclRhcmdldDJbJ2RlZmF1bHQnXSxcbiAgICAgIGNyZWF0ZU1vbml0b3I6IF9jcmVhdGVUYXJnZXRNb25pdG9yMlsnZGVmYXVsdCddLFxuICAgICAgY3JlYXRlQ29ubmVjdG9yOiBfY3JlYXRlVGFyZ2V0Q29ubmVjdG9yMlsnZGVmYXVsdCddLFxuICAgICAgRGVjb3JhdGVkQ29tcG9uZW50OiBEZWNvcmF0ZWRDb21wb25lbnQsXG4gICAgICBnZXRUeXBlOiBnZXRUeXBlLFxuICAgICAgY29sbGVjdDogY29sbGVjdCxcbiAgICAgIG9wdGlvbnM6IG9wdGlvbnNcbiAgICB9KTtcbiAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gYXJlT3B0aW9uc0VxdWFsO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfdXRpbHNTaGFsbG93RXF1YWwgPSByZXF1aXJlKCcuL3V0aWxzL3NoYWxsb3dFcXVhbCcpO1xuXG52YXIgX3V0aWxzU2hhbGxvd0VxdWFsMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3V0aWxzU2hhbGxvd0VxdWFsKTtcblxuZnVuY3Rpb24gYXJlT3B0aW9uc0VxdWFsKG5leHRPcHRpb25zLCBjdXJyZW50T3B0aW9ucykge1xuICBpZiAoY3VycmVudE9wdGlvbnMgPT09IG5leHRPcHRpb25zKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICByZXR1cm4gY3VycmVudE9wdGlvbnMgIT09IG51bGwgJiYgbmV4dE9wdGlvbnMgIT09IG51bGwgJiYgX3V0aWxzU2hhbGxvd0VxdWFsMlsnZGVmYXVsdCddKGN1cnJlbnRPcHRpb25zLCBuZXh0T3B0aW9ucyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IGNyZWF0ZVNvdXJjZUNvbm5lY3RvcjtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG52YXIgX3dyYXBDb25uZWN0b3JIb29rcyA9IHJlcXVpcmUoJy4vd3JhcENvbm5lY3Rvckhvb2tzJyk7XG5cbnZhciBfd3JhcENvbm5lY3Rvckhvb2tzMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3dyYXBDb25uZWN0b3JIb29rcyk7XG5cbnZhciBfYXJlT3B0aW9uc0VxdWFsID0gcmVxdWlyZSgnLi9hcmVPcHRpb25zRXF1YWwnKTtcblxudmFyIF9hcmVPcHRpb25zRXF1YWwyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfYXJlT3B0aW9uc0VxdWFsKTtcblxuZnVuY3Rpb24gY3JlYXRlU291cmNlQ29ubmVjdG9yKGJhY2tlbmQpIHtcbiAgdmFyIGN1cnJlbnRIYW5kbGVySWQgPSB1bmRlZmluZWQ7XG5cbiAgdmFyIGN1cnJlbnREcmFnU291cmNlTm9kZSA9IHVuZGVmaW5lZDtcbiAgdmFyIGN1cnJlbnREcmFnU291cmNlT3B0aW9ucyA9IHVuZGVmaW5lZDtcbiAgdmFyIGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1NvdXJjZSA9IHVuZGVmaW5lZDtcblxuICB2YXIgY3VycmVudERyYWdQcmV2aWV3Tm9kZSA9IHVuZGVmaW5lZDtcbiAgdmFyIGN1cnJlbnREcmFnUHJldmlld09wdGlvbnMgPSB1bmRlZmluZWQ7XG4gIHZhciBkaXNjb25uZWN0Q3VycmVudERyYWdQcmV2aWV3ID0gdW5kZWZpbmVkO1xuXG4gIGZ1bmN0aW9uIHJlY29ubmVjdERyYWdTb3VyY2UoKSB7XG4gICAgaWYgKGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1NvdXJjZSkge1xuICAgICAgZGlzY29ubmVjdEN1cnJlbnREcmFnU291cmNlKCk7XG4gICAgICBkaXNjb25uZWN0Q3VycmVudERyYWdTb3VyY2UgPSBudWxsO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50SGFuZGxlcklkICYmIGN1cnJlbnREcmFnU291cmNlTm9kZSkge1xuICAgICAgZGlzY29ubmVjdEN1cnJlbnREcmFnU291cmNlID0gYmFja2VuZC5jb25uZWN0RHJhZ1NvdXJjZShjdXJyZW50SGFuZGxlcklkLCBjdXJyZW50RHJhZ1NvdXJjZU5vZGUsIGN1cnJlbnREcmFnU291cmNlT3B0aW9ucyk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVjb25uZWN0RHJhZ1ByZXZpZXcoKSB7XG4gICAgaWYgKGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1ByZXZpZXcpIHtcbiAgICAgIGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1ByZXZpZXcoKTtcbiAgICAgIGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1ByZXZpZXcgPSBudWxsO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50SGFuZGxlcklkICYmIGN1cnJlbnREcmFnUHJldmlld05vZGUpIHtcbiAgICAgIGRpc2Nvbm5lY3RDdXJyZW50RHJhZ1ByZXZpZXcgPSBiYWNrZW5kLmNvbm5lY3REcmFnUHJldmlldyhjdXJyZW50SGFuZGxlcklkLCBjdXJyZW50RHJhZ1ByZXZpZXdOb2RlLCBjdXJyZW50RHJhZ1ByZXZpZXdPcHRpb25zKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiByZWNlaXZlSGFuZGxlcklkKGhhbmRsZXJJZCkge1xuICAgIGlmIChoYW5kbGVySWQgPT09IGN1cnJlbnRIYW5kbGVySWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjdXJyZW50SGFuZGxlcklkID0gaGFuZGxlcklkO1xuICAgIHJlY29ubmVjdERyYWdTb3VyY2UoKTtcbiAgICByZWNvbm5lY3REcmFnUHJldmlldygpO1xuICB9XG5cbiAgdmFyIGhvb2tzID0gX3dyYXBDb25uZWN0b3JIb29rczJbJ2RlZmF1bHQnXSh7XG4gICAgZHJhZ1NvdXJjZTogZnVuY3Rpb24gY29ubmVjdERyYWdTb3VyY2Uobm9kZSwgb3B0aW9ucykge1xuICAgICAgaWYgKG5vZGUgPT09IGN1cnJlbnREcmFnU291cmNlTm9kZSAmJiBfYXJlT3B0aW9uc0VxdWFsMlsnZGVmYXVsdCddKG9wdGlvbnMsIGN1cnJlbnREcmFnU291cmNlT3B0aW9ucykpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjdXJyZW50RHJhZ1NvdXJjZU5vZGUgPSBub2RlO1xuICAgICAgY3VycmVudERyYWdTb3VyY2VPcHRpb25zID0gb3B0aW9ucztcblxuICAgICAgcmVjb25uZWN0RHJhZ1NvdXJjZSgpO1xuICAgIH0sXG5cbiAgICBkcmFnUHJldmlldzogZnVuY3Rpb24gY29ubmVjdERyYWdQcmV2aWV3KG5vZGUsIG9wdGlvbnMpIHtcbiAgICAgIGlmIChub2RlID09PSBjdXJyZW50RHJhZ1ByZXZpZXdOb2RlICYmIF9hcmVPcHRpb25zRXF1YWwyWydkZWZhdWx0J10ob3B0aW9ucywgY3VycmVudERyYWdQcmV2aWV3T3B0aW9ucykpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjdXJyZW50RHJhZ1ByZXZpZXdOb2RlID0gbm9kZTtcbiAgICAgIGN1cnJlbnREcmFnUHJldmlld09wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgICByZWNvbm5lY3REcmFnUHJldmlldygpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICByZWNlaXZlSGFuZGxlcklkOiByZWNlaXZlSGFuZGxlcklkLFxuICAgIGhvb2tzOiBob29rc1xuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBjcmVhdGVTb3VyY2VGYWN0b3J5O1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcignQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uJyk7IH0gfVxuXG52YXIgX2ludmFyaWFudCA9IHJlcXVpcmUoJ2ludmFyaWFudCcpO1xuXG52YXIgX2ludmFyaWFudDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9pbnZhcmlhbnQpO1xuXG52YXIgX2xvZGFzaElzUGxhaW5PYmplY3QgPSByZXF1aXJlKCdsb2Rhc2gvaXNQbGFpbk9iamVjdCcpO1xuXG52YXIgX2xvZGFzaElzUGxhaW5PYmplY3QyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNQbGFpbk9iamVjdCk7XG5cbnZhciBBTExPV0VEX1NQRUNfTUVUSE9EUyA9IFsnY2FuRHJhZycsICdiZWdpbkRyYWcnLCAnY2FuRHJhZycsICdpc0RyYWdnaW5nJywgJ2VuZERyYWcnXTtcbnZhciBSRVFVSVJFRF9TUEVDX01FVEhPRFMgPSBbJ2JlZ2luRHJhZyddO1xuXG5mdW5jdGlvbiBjcmVhdGVTb3VyY2VGYWN0b3J5KHNwZWMpIHtcbiAgT2JqZWN0LmtleXMoc3BlYykuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShBTExPV0VEX1NQRUNfTUVUSE9EUy5pbmRleE9mKGtleSkgPiAtMSwgJ0V4cGVjdGVkIHRoZSBkcmFnIHNvdXJjZSBzcGVjaWZpY2F0aW9uIHRvIG9ubHkgaGF2ZSAnICsgJ3NvbWUgb2YgdGhlIGZvbGxvd2luZyBrZXlzOiAlcy4gJyArICdJbnN0ZWFkIHJlY2VpdmVkIGEgc3BlY2lmaWNhdGlvbiB3aXRoIGFuIHVuZXhwZWN0ZWQgXCIlc1wiIGtleS4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcmFnLXNvdXJjZS5odG1sJywgQUxMT1dFRF9TUEVDX01FVEhPRFMuam9pbignLCAnKSwga2V5KTtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBzcGVjW2tleV0gPT09ICdmdW5jdGlvbicsICdFeHBlY3RlZCAlcyBpbiB0aGUgZHJhZyBzb3VyY2Ugc3BlY2lmaWNhdGlvbiB0byBiZSBhIGZ1bmN0aW9uLiAnICsgJ0luc3RlYWQgcmVjZWl2ZWQgYSBzcGVjaWZpY2F0aW9uIHdpdGggJXM6ICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyYWctc291cmNlLmh0bWwnLCBrZXksIGtleSwgc3BlY1trZXldKTtcbiAgfSk7XG4gIFJFUVVJUkVEX1NQRUNfTUVUSE9EUy5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHtcbiAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiBzcGVjW2tleV0gPT09ICdmdW5jdGlvbicsICdFeHBlY3RlZCAlcyBpbiB0aGUgZHJhZyBzb3VyY2Ugc3BlY2lmaWNhdGlvbiB0byBiZSBhIGZ1bmN0aW9uLiAnICsgJ0luc3RlYWQgcmVjZWl2ZWQgYSBzcGVjaWZpY2F0aW9uIHdpdGggJXM6ICVzLiAnICsgJ1JlYWQgbW9yZTogaHR0cDovL2dhZWFyb24uZ2l0aHViLmlvL3JlYWN0LWRuZC9kb2NzLWRyYWctc291cmNlLmh0bWwnLCBrZXksIGtleSwgc3BlY1trZXldKTtcbiAgfSk7XG5cbiAgdmFyIFNvdXJjZSA9IChmdW5jdGlvbiAoKSB7XG4gICAgZnVuY3Rpb24gU291cmNlKG1vbml0b3IpIHtcbiAgICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBTb3VyY2UpO1xuXG4gICAgICB0aGlzLm1vbml0b3IgPSBtb25pdG9yO1xuICAgICAgdGhpcy5wcm9wcyA9IG51bGw7XG4gICAgICB0aGlzLmNvbXBvbmVudCA9IG51bGw7XG4gICAgfVxuXG4gICAgU291cmNlLnByb3RvdHlwZS5yZWNlaXZlUHJvcHMgPSBmdW5jdGlvbiByZWNlaXZlUHJvcHMocHJvcHMpIHtcbiAgICAgIHRoaXMucHJvcHMgPSBwcm9wcztcbiAgICB9O1xuXG4gICAgU291cmNlLnByb3RvdHlwZS5yZWNlaXZlQ29tcG9uZW50ID0gZnVuY3Rpb24gcmVjZWl2ZUNvbXBvbmVudChjb21wb25lbnQpIHtcbiAgICAgIHRoaXMuY29tcG9uZW50ID0gY29tcG9uZW50O1xuICAgIH07XG5cbiAgICBTb3VyY2UucHJvdG90eXBlLmNhbkRyYWcgPSBmdW5jdGlvbiBjYW5EcmFnKCkge1xuICAgICAgaWYgKCFzcGVjLmNhbkRyYWcpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBzcGVjLmNhbkRyYWcodGhpcy5wcm9wcywgdGhpcy5tb25pdG9yKTtcbiAgICB9O1xuXG4gICAgU291cmNlLnByb3RvdHlwZS5pc0RyYWdnaW5nID0gZnVuY3Rpb24gaXNEcmFnZ2luZyhnbG9iYWxNb25pdG9yLCBzb3VyY2VJZCkge1xuICAgICAgaWYgKCFzcGVjLmlzRHJhZ2dpbmcpIHtcbiAgICAgICAgcmV0dXJuIHNvdXJjZUlkID09PSBnbG9iYWxNb25pdG9yLmdldFNvdXJjZUlkKCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBzcGVjLmlzRHJhZ2dpbmcodGhpcy5wcm9wcywgdGhpcy5tb25pdG9yKTtcbiAgICB9O1xuXG4gICAgU291cmNlLnByb3RvdHlwZS5iZWdpbkRyYWcgPSBmdW5jdGlvbiBiZWdpbkRyYWcoKSB7XG4gICAgICB2YXIgaXRlbSA9IHNwZWMuYmVnaW5EcmFnKHRoaXMucHJvcHMsIHRoaXMubW9uaXRvciwgdGhpcy5jb21wb25lbnQpO1xuICAgICAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WICE9PSAncHJvZHVjdGlvbicpIHtcbiAgICAgICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXShfbG9kYXNoSXNQbGFpbk9iamVjdDJbJ2RlZmF1bHQnXShpdGVtKSwgJ2JlZ2luRHJhZygpIG11c3QgcmV0dXJuIGEgcGxhaW4gb2JqZWN0IHRoYXQgcmVwcmVzZW50cyB0aGUgZHJhZ2dlZCBpdGVtLiAnICsgJ0luc3RlYWQgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJhZy1zb3VyY2UuaHRtbCcsIGl0ZW0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGl0ZW07XG4gICAgfTtcblxuICAgIFNvdXJjZS5wcm90b3R5cGUuZW5kRHJhZyA9IGZ1bmN0aW9uIGVuZERyYWcoKSB7XG4gICAgICBpZiAoIXNwZWMuZW5kRHJhZykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHNwZWMuZW5kRHJhZyh0aGlzLnByb3BzLCB0aGlzLm1vbml0b3IsIHRoaXMuY29tcG9uZW50KTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIFNvdXJjZTtcbiAgfSkoKTtcblxuICByZXR1cm4gZnVuY3Rpb24gY3JlYXRlU291cmNlKG1vbml0b3IpIHtcbiAgICByZXR1cm4gbmV3IFNvdXJjZShtb25pdG9yKTtcbiAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gY3JlYXRlU291cmNlTW9uaXRvcjtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoJ0Nhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvbicpOyB9IH1cblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIGlzQ2FsbGluZ0NhbkRyYWcgPSBmYWxzZTtcbnZhciBpc0NhbGxpbmdJc0RyYWdnaW5nID0gZmFsc2U7XG5cbnZhciBTb3VyY2VNb25pdG9yID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gU291cmNlTW9uaXRvcihtYW5hZ2VyKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFNvdXJjZU1vbml0b3IpO1xuXG4gICAgdGhpcy5pbnRlcm5hbE1vbml0b3IgPSBtYW5hZ2VyLmdldE1vbml0b3IoKTtcbiAgfVxuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLnJlY2VpdmVIYW5kbGVySWQgPSBmdW5jdGlvbiByZWNlaXZlSGFuZGxlcklkKHNvdXJjZUlkKSB7XG4gICAgdGhpcy5zb3VyY2VJZCA9IHNvdXJjZUlkO1xuICB9O1xuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLmNhbkRyYWcgPSBmdW5jdGlvbiBjYW5EcmFnKCkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIWlzQ2FsbGluZ0NhbkRyYWcsICdZb3UgbWF5IG5vdCBjYWxsIG1vbml0b3IuY2FuRHJhZygpIGluc2lkZSB5b3VyIGNhbkRyYWcoKSBpbXBsZW1lbnRhdGlvbi4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcmFnLXNvdXJjZS1tb25pdG9yLmh0bWwnKTtcblxuICAgIHRyeSB7XG4gICAgICBpc0NhbGxpbmdDYW5EcmFnID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5jYW5EcmFnU291cmNlKHRoaXMuc291cmNlSWQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpc0NhbGxpbmdDYW5EcmFnID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLmlzRHJhZ2dpbmcgPSBmdW5jdGlvbiBpc0RyYWdnaW5nKCkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIWlzQ2FsbGluZ0lzRHJhZ2dpbmcsICdZb3UgbWF5IG5vdCBjYWxsIG1vbml0b3IuaXNEcmFnZ2luZygpIGluc2lkZSB5b3VyIGlzRHJhZ2dpbmcoKSBpbXBsZW1lbnRhdGlvbi4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcmFnLXNvdXJjZS1tb25pdG9yLmh0bWwnKTtcblxuICAgIHRyeSB7XG4gICAgICBpc0NhbGxpbmdJc0RyYWdnaW5nID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5pc0RyYWdnaW5nU291cmNlKHRoaXMuc291cmNlSWQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpc0NhbGxpbmdJc0RyYWdnaW5nID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLmdldEl0ZW1UeXBlID0gZnVuY3Rpb24gZ2V0SXRlbVR5cGUoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEl0ZW1UeXBlKCk7XG4gIH07XG5cbiAgU291cmNlTW9uaXRvci5wcm90b3R5cGUuZ2V0SXRlbSA9IGZ1bmN0aW9uIGdldEl0ZW0oKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEl0ZW0oKTtcbiAgfTtcblxuICBTb3VyY2VNb25pdG9yLnByb3RvdHlwZS5nZXREcm9wUmVzdWx0ID0gZnVuY3Rpb24gZ2V0RHJvcFJlc3VsdCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0RHJvcFJlc3VsdCgpO1xuICB9O1xuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLmRpZERyb3AgPSBmdW5jdGlvbiBkaWREcm9wKCkge1xuICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5kaWREcm9wKCk7XG4gIH07XG5cbiAgU291cmNlTW9uaXRvci5wcm90b3R5cGUuZ2V0SW5pdGlhbENsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldEluaXRpYWxDbGllbnRPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEluaXRpYWxDbGllbnRPZmZzZXQoKTtcbiAgfTtcblxuICBTb3VyY2VNb25pdG9yLnByb3RvdHlwZS5nZXRJbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0ID0gZnVuY3Rpb24gZ2V0SW5pdGlhbFNvdXJjZUNsaWVudE9mZnNldCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0SW5pdGlhbFNvdXJjZUNsaWVudE9mZnNldCgpO1xuICB9O1xuXG4gIFNvdXJjZU1vbml0b3IucHJvdG90eXBlLmdldFNvdXJjZUNsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldFNvdXJjZUNsaWVudE9mZnNldCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0U291cmNlQ2xpZW50T2Zmc2V0KCk7XG4gIH07XG5cbiAgU291cmNlTW9uaXRvci5wcm90b3R5cGUuZ2V0Q2xpZW50T2Zmc2V0ID0gZnVuY3Rpb24gZ2V0Q2xpZW50T2Zmc2V0KCkge1xuICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5nZXRDbGllbnRPZmZzZXQoKTtcbiAgfTtcblxuICBTb3VyY2VNb25pdG9yLnByb3RvdHlwZS5nZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQgPSBmdW5jdGlvbiBnZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldERpZmZlcmVuY2VGcm9tSW5pdGlhbE9mZnNldCgpO1xuICB9O1xuXG4gIHJldHVybiBTb3VyY2VNb25pdG9yO1xufSkoKTtcblxuZnVuY3Rpb24gY3JlYXRlU291cmNlTW9uaXRvcihtYW5hZ2VyKSB7XG4gIHJldHVybiBuZXcgU291cmNlTW9uaXRvcihtYW5hZ2VyKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gY3JlYXRlVGFyZ2V0Q29ubmVjdG9yO1xuXG5mdW5jdGlvbiBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KG9iaikgeyByZXR1cm4gb2JqICYmIG9iai5fX2VzTW9kdWxlID8gb2JqIDogeyAnZGVmYXVsdCc6IG9iaiB9OyB9XG5cbnZhciBfd3JhcENvbm5lY3Rvckhvb2tzID0gcmVxdWlyZSgnLi93cmFwQ29ubmVjdG9ySG9va3MnKTtcblxudmFyIF93cmFwQ29ubmVjdG9ySG9va3MyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfd3JhcENvbm5lY3Rvckhvb2tzKTtcblxudmFyIF9hcmVPcHRpb25zRXF1YWwgPSByZXF1aXJlKCcuL2FyZU9wdGlvbnNFcXVhbCcpO1xuXG52YXIgX2FyZU9wdGlvbnNFcXVhbDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9hcmVPcHRpb25zRXF1YWwpO1xuXG5mdW5jdGlvbiBjcmVhdGVUYXJnZXRDb25uZWN0b3IoYmFja2VuZCkge1xuICB2YXIgY3VycmVudEhhbmRsZXJJZCA9IHVuZGVmaW5lZDtcblxuICB2YXIgY3VycmVudERyb3BUYXJnZXROb2RlID0gdW5kZWZpbmVkO1xuICB2YXIgY3VycmVudERyb3BUYXJnZXRPcHRpb25zID0gdW5kZWZpbmVkO1xuICB2YXIgZGlzY29ubmVjdEN1cnJlbnREcm9wVGFyZ2V0ID0gdW5kZWZpbmVkO1xuXG4gIGZ1bmN0aW9uIHJlY29ubmVjdERyb3BUYXJnZXQoKSB7XG4gICAgaWYgKGRpc2Nvbm5lY3RDdXJyZW50RHJvcFRhcmdldCkge1xuICAgICAgZGlzY29ubmVjdEN1cnJlbnREcm9wVGFyZ2V0KCk7XG4gICAgICBkaXNjb25uZWN0Q3VycmVudERyb3BUYXJnZXQgPSBudWxsO1xuICAgIH1cblxuICAgIGlmIChjdXJyZW50SGFuZGxlcklkICYmIGN1cnJlbnREcm9wVGFyZ2V0Tm9kZSkge1xuICAgICAgZGlzY29ubmVjdEN1cnJlbnREcm9wVGFyZ2V0ID0gYmFja2VuZC5jb25uZWN0RHJvcFRhcmdldChjdXJyZW50SGFuZGxlcklkLCBjdXJyZW50RHJvcFRhcmdldE5vZGUsIGN1cnJlbnREcm9wVGFyZ2V0T3B0aW9ucyk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gcmVjZWl2ZUhhbmRsZXJJZChoYW5kbGVySWQpIHtcbiAgICBpZiAoaGFuZGxlcklkID09PSBjdXJyZW50SGFuZGxlcklkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY3VycmVudEhhbmRsZXJJZCA9IGhhbmRsZXJJZDtcbiAgICByZWNvbm5lY3REcm9wVGFyZ2V0KCk7XG4gIH1cblxuICB2YXIgaG9va3MgPSBfd3JhcENvbm5lY3Rvckhvb2tzMlsnZGVmYXVsdCddKHtcbiAgICBkcm9wVGFyZ2V0OiBmdW5jdGlvbiBjb25uZWN0RHJvcFRhcmdldChub2RlLCBvcHRpb25zKSB7XG4gICAgICBpZiAobm9kZSA9PT0gY3VycmVudERyb3BUYXJnZXROb2RlICYmIF9hcmVPcHRpb25zRXF1YWwyWydkZWZhdWx0J10ob3B0aW9ucywgY3VycmVudERyb3BUYXJnZXRPcHRpb25zKSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGN1cnJlbnREcm9wVGFyZ2V0Tm9kZSA9IG5vZGU7XG4gICAgICBjdXJyZW50RHJvcFRhcmdldE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgICByZWNvbm5lY3REcm9wVGFyZ2V0KCk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHJlY2VpdmVIYW5kbGVySWQ6IHJlY2VpdmVIYW5kbGVySWQsXG4gICAgaG9va3M6IGhvb2tzXG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IGNyZWF0ZVRhcmdldEZhY3Rvcnk7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbnZhciBfaW52YXJpYW50ID0gcmVxdWlyZSgnaW52YXJpYW50Jyk7XG5cbnZhciBfaW52YXJpYW50MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2ludmFyaWFudCk7XG5cbnZhciBfbG9kYXNoSXNQbGFpbk9iamVjdCA9IHJlcXVpcmUoJ2xvZGFzaC9pc1BsYWluT2JqZWN0Jyk7XG5cbnZhciBfbG9kYXNoSXNQbGFpbk9iamVjdDIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9sb2Rhc2hJc1BsYWluT2JqZWN0KTtcblxudmFyIEFMTE9XRURfU1BFQ19NRVRIT0RTID0gWydjYW5Ecm9wJywgJ2hvdmVyJywgJ2Ryb3AnXTtcblxuZnVuY3Rpb24gY3JlYXRlVGFyZ2V0RmFjdG9yeShzcGVjKSB7XG4gIE9iamVjdC5rZXlzKHNwZWMpLmZvckVhY2goZnVuY3Rpb24gKGtleSkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oQUxMT1dFRF9TUEVDX01FVEhPRFMuaW5kZXhPZihrZXkpID4gLTEsICdFeHBlY3RlZCB0aGUgZHJvcCB0YXJnZXQgc3BlY2lmaWNhdGlvbiB0byBvbmx5IGhhdmUgJyArICdzb21lIG9mIHRoZSBmb2xsb3dpbmcga2V5czogJXMuICcgKyAnSW5zdGVhZCByZWNlaXZlZCBhIHNwZWNpZmljYXRpb24gd2l0aCBhbiB1bmV4cGVjdGVkIFwiJXNcIiBrZXkuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJvcC10YXJnZXQuaHRtbCcsIEFMTE9XRURfU1BFQ19NRVRIT0RTLmpvaW4oJywgJyksIGtleSk7XG4gICAgX2ludmFyaWFudDJbJ2RlZmF1bHQnXSh0eXBlb2Ygc3BlY1trZXldID09PSAnZnVuY3Rpb24nLCAnRXhwZWN0ZWQgJXMgaW4gdGhlIGRyb3AgdGFyZ2V0IHNwZWNpZmljYXRpb24gdG8gYmUgYSBmdW5jdGlvbi4gJyArICdJbnN0ZWFkIHJlY2VpdmVkIGEgc3BlY2lmaWNhdGlvbiB3aXRoICVzOiAlcy4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcm9wLXRhcmdldC5odG1sJywga2V5LCBrZXksIHNwZWNba2V5XSk7XG4gIH0pO1xuXG4gIHZhciBUYXJnZXQgPSAoZnVuY3Rpb24gKCkge1xuICAgIGZ1bmN0aW9uIFRhcmdldChtb25pdG9yKSB7XG4gICAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgVGFyZ2V0KTtcblxuICAgICAgdGhpcy5tb25pdG9yID0gbW9uaXRvcjtcbiAgICAgIHRoaXMucHJvcHMgPSBudWxsO1xuICAgICAgdGhpcy5jb21wb25lbnQgPSBudWxsO1xuICAgIH1cblxuICAgIFRhcmdldC5wcm90b3R5cGUucmVjZWl2ZVByb3BzID0gZnVuY3Rpb24gcmVjZWl2ZVByb3BzKHByb3BzKSB7XG4gICAgICB0aGlzLnByb3BzID0gcHJvcHM7XG4gICAgfTtcblxuICAgIFRhcmdldC5wcm90b3R5cGUucmVjZWl2ZU1vbml0b3IgPSBmdW5jdGlvbiByZWNlaXZlTW9uaXRvcihtb25pdG9yKSB7XG4gICAgICB0aGlzLm1vbml0b3IgPSBtb25pdG9yO1xuICAgIH07XG5cbiAgICBUYXJnZXQucHJvdG90eXBlLnJlY2VpdmVDb21wb25lbnQgPSBmdW5jdGlvbiByZWNlaXZlQ29tcG9uZW50KGNvbXBvbmVudCkge1xuICAgICAgdGhpcy5jb21wb25lbnQgPSBjb21wb25lbnQ7XG4gICAgfTtcblxuICAgIFRhcmdldC5wcm90b3R5cGUuY2FuRHJvcCA9IGZ1bmN0aW9uIGNhbkRyb3AoKSB7XG4gICAgICBpZiAoIXNwZWMuY2FuRHJvcCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHNwZWMuY2FuRHJvcCh0aGlzLnByb3BzLCB0aGlzLm1vbml0b3IpO1xuICAgIH07XG5cbiAgICBUYXJnZXQucHJvdG90eXBlLmhvdmVyID0gZnVuY3Rpb24gaG92ZXIoKSB7XG4gICAgICBpZiAoIXNwZWMuaG92ZXIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzcGVjLmhvdmVyKHRoaXMucHJvcHMsIHRoaXMubW9uaXRvciwgdGhpcy5jb21wb25lbnQpO1xuICAgIH07XG5cbiAgICBUYXJnZXQucHJvdG90eXBlLmRyb3AgPSBmdW5jdGlvbiBkcm9wKCkge1xuICAgICAgaWYgKCFzcGVjLmRyb3ApIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgZHJvcFJlc3VsdCA9IHNwZWMuZHJvcCh0aGlzLnByb3BzLCB0aGlzLm1vbml0b3IsIHRoaXMuY29tcG9uZW50KTtcbiAgICAgIGlmIChwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nKSB7XG4gICAgICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIGRyb3BSZXN1bHQgPT09ICd1bmRlZmluZWQnIHx8IF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKGRyb3BSZXN1bHQpLCAnZHJvcCgpIG11c3QgZWl0aGVyIHJldHVybiB1bmRlZmluZWQsIG9yIGFuIG9iamVjdCB0aGF0IHJlcHJlc2VudHMgdGhlIGRyb3AgcmVzdWx0LiAnICsgJ0luc3RlYWQgcmVjZWl2ZWQgJXMuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtZHJvcC10YXJnZXQuaHRtbCcsIGRyb3BSZXN1bHQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGRyb3BSZXN1bHQ7XG4gICAgfTtcblxuICAgIHJldHVybiBUYXJnZXQ7XG4gIH0pKCk7XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIGNyZWF0ZVRhcmdldChtb25pdG9yKSB7XG4gICAgcmV0dXJuIG5ldyBUYXJnZXQobW9uaXRvcik7XG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IGNyZWF0ZVRhcmdldE1vbml0b3I7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbnZhciBfaW52YXJpYW50ID0gcmVxdWlyZSgnaW52YXJpYW50Jyk7XG5cbnZhciBfaW52YXJpYW50MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2ludmFyaWFudCk7XG5cbnZhciBpc0NhbGxpbmdDYW5Ecm9wID0gZmFsc2U7XG5cbnZhciBUYXJnZXRNb25pdG9yID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gVGFyZ2V0TW9uaXRvcihtYW5hZ2VyKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFRhcmdldE1vbml0b3IpO1xuXG4gICAgdGhpcy5pbnRlcm5hbE1vbml0b3IgPSBtYW5hZ2VyLmdldE1vbml0b3IoKTtcbiAgfVxuXG4gIFRhcmdldE1vbml0b3IucHJvdG90eXBlLnJlY2VpdmVIYW5kbGVySWQgPSBmdW5jdGlvbiByZWNlaXZlSGFuZGxlcklkKHRhcmdldElkKSB7XG4gICAgdGhpcy50YXJnZXRJZCA9IHRhcmdldElkO1xuICB9O1xuXG4gIFRhcmdldE1vbml0b3IucHJvdG90eXBlLmNhbkRyb3AgPSBmdW5jdGlvbiBjYW5Ecm9wKCkge1xuICAgIF9pbnZhcmlhbnQyWydkZWZhdWx0J10oIWlzQ2FsbGluZ0NhbkRyb3AsICdZb3UgbWF5IG5vdCBjYWxsIG1vbml0b3IuY2FuRHJvcCgpIGluc2lkZSB5b3VyIGNhbkRyb3AoKSBpbXBsZW1lbnRhdGlvbi4gJyArICdSZWFkIG1vcmU6IGh0dHA6Ly9nYWVhcm9uLmdpdGh1Yi5pby9yZWFjdC1kbmQvZG9jcy1kcm9wLXRhcmdldC1tb25pdG9yLmh0bWwnKTtcblxuICAgIHRyeSB7XG4gICAgICBpc0NhbGxpbmdDYW5Ecm9wID0gdHJ1ZTtcbiAgICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5jYW5Ecm9wT25UYXJnZXQodGhpcy50YXJnZXRJZCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlzQ2FsbGluZ0NhbkRyb3AgPSBmYWxzZTtcbiAgICB9XG4gIH07XG5cbiAgVGFyZ2V0TW9uaXRvci5wcm90b3R5cGUuaXNPdmVyID0gZnVuY3Rpb24gaXNPdmVyKG9wdGlvbnMpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuaXNPdmVyVGFyZ2V0KHRoaXMudGFyZ2V0SWQsIG9wdGlvbnMpO1xuICB9O1xuXG4gIFRhcmdldE1vbml0b3IucHJvdG90eXBlLmdldEl0ZW1UeXBlID0gZnVuY3Rpb24gZ2V0SXRlbVR5cGUoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEl0ZW1UeXBlKCk7XG4gIH07XG5cbiAgVGFyZ2V0TW9uaXRvci5wcm90b3R5cGUuZ2V0SXRlbSA9IGZ1bmN0aW9uIGdldEl0ZW0oKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEl0ZW0oKTtcbiAgfTtcblxuICBUYXJnZXRNb25pdG9yLnByb3RvdHlwZS5nZXREcm9wUmVzdWx0ID0gZnVuY3Rpb24gZ2V0RHJvcFJlc3VsdCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0RHJvcFJlc3VsdCgpO1xuICB9O1xuXG4gIFRhcmdldE1vbml0b3IucHJvdG90eXBlLmRpZERyb3AgPSBmdW5jdGlvbiBkaWREcm9wKCkge1xuICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5kaWREcm9wKCk7XG4gIH07XG5cbiAgVGFyZ2V0TW9uaXRvci5wcm90b3R5cGUuZ2V0SW5pdGlhbENsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldEluaXRpYWxDbGllbnRPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldEluaXRpYWxDbGllbnRPZmZzZXQoKTtcbiAgfTtcblxuICBUYXJnZXRNb25pdG9yLnByb3RvdHlwZS5nZXRJbml0aWFsU291cmNlQ2xpZW50T2Zmc2V0ID0gZnVuY3Rpb24gZ2V0SW5pdGlhbFNvdXJjZUNsaWVudE9mZnNldCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0SW5pdGlhbFNvdXJjZUNsaWVudE9mZnNldCgpO1xuICB9O1xuXG4gIFRhcmdldE1vbml0b3IucHJvdG90eXBlLmdldFNvdXJjZUNsaWVudE9mZnNldCA9IGZ1bmN0aW9uIGdldFNvdXJjZUNsaWVudE9mZnNldCgpIHtcbiAgICByZXR1cm4gdGhpcy5pbnRlcm5hbE1vbml0b3IuZ2V0U291cmNlQ2xpZW50T2Zmc2V0KCk7XG4gIH07XG5cbiAgVGFyZ2V0TW9uaXRvci5wcm90b3R5cGUuZ2V0Q2xpZW50T2Zmc2V0ID0gZnVuY3Rpb24gZ2V0Q2xpZW50T2Zmc2V0KCkge1xuICAgIHJldHVybiB0aGlzLmludGVybmFsTW9uaXRvci5nZXRDbGllbnRPZmZzZXQoKTtcbiAgfTtcblxuICBUYXJnZXRNb25pdG9yLnByb3RvdHlwZS5nZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQgPSBmdW5jdGlvbiBnZXREaWZmZXJlbmNlRnJvbUluaXRpYWxPZmZzZXQoKSB7XG4gICAgcmV0dXJuIHRoaXMuaW50ZXJuYWxNb25pdG9yLmdldERpZmZlcmVuY2VGcm9tSW5pdGlhbE9mZnNldCgpO1xuICB9O1xuXG4gIHJldHVybiBUYXJnZXRNb25pdG9yO1xufSkoKTtcblxuZnVuY3Rpb24gY3JlYXRlVGFyZ2V0TW9uaXRvcihtYW5hZ2VyKSB7XG4gIHJldHVybiBuZXcgVGFyZ2V0TW9uaXRvcihtYW5hZ2VyKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG52YXIgX2V4dGVuZHMgPSBPYmplY3QuYXNzaWduIHx8IGZ1bmN0aW9uICh0YXJnZXQpIHsgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHsgdmFyIHNvdXJjZSA9IGFyZ3VtZW50c1tpXTsgZm9yICh2YXIga2V5IGluIHNvdXJjZSkgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHNvdXJjZSwga2V5KSkgeyB0YXJnZXRba2V5XSA9IHNvdXJjZVtrZXldOyB9IH0gfSByZXR1cm4gdGFyZ2V0OyB9O1xuXG52YXIgX2NyZWF0ZUNsYXNzID0gKGZ1bmN0aW9uICgpIHsgZnVuY3Rpb24gZGVmaW5lUHJvcGVydGllcyh0YXJnZXQsIHByb3BzKSB7IGZvciAodmFyIGkgPSAwOyBpIDwgcHJvcHMubGVuZ3RoOyBpKyspIHsgdmFyIGRlc2NyaXB0b3IgPSBwcm9wc1tpXTsgZGVzY3JpcHRvci5lbnVtZXJhYmxlID0gZGVzY3JpcHRvci5lbnVtZXJhYmxlIHx8IGZhbHNlOyBkZXNjcmlwdG9yLmNvbmZpZ3VyYWJsZSA9IHRydWU7IGlmICgndmFsdWUnIGluIGRlc2NyaXB0b3IpIGRlc2NyaXB0b3Iud3JpdGFibGUgPSB0cnVlOyBPYmplY3QuZGVmaW5lUHJvcGVydHkodGFyZ2V0LCBkZXNjcmlwdG9yLmtleSwgZGVzY3JpcHRvcik7IH0gfSByZXR1cm4gZnVuY3Rpb24gKENvbnN0cnVjdG9yLCBwcm90b1Byb3BzLCBzdGF0aWNQcm9wcykgeyBpZiAocHJvdG9Qcm9wcykgZGVmaW5lUHJvcGVydGllcyhDb25zdHJ1Y3Rvci5wcm90b3R5cGUsIHByb3RvUHJvcHMpOyBpZiAoc3RhdGljUHJvcHMpIGRlZmluZVByb3BlcnRpZXMoQ29uc3RydWN0b3IsIHN0YXRpY1Byb3BzKTsgcmV0dXJuIENvbnN0cnVjdG9yOyB9OyB9KSgpO1xuXG5leHBvcnRzWydkZWZhdWx0J10gPSBkZWNvcmF0ZUhhbmRsZXI7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb24nKTsgfSB9XG5cbmZ1bmN0aW9uIF9pbmhlcml0cyhzdWJDbGFzcywgc3VwZXJDbGFzcykgeyBpZiAodHlwZW9mIHN1cGVyQ2xhc3MgIT09ICdmdW5jdGlvbicgJiYgc3VwZXJDbGFzcyAhPT0gbnVsbCkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKCdTdXBlciBleHByZXNzaW9uIG11c3QgZWl0aGVyIGJlIG51bGwgb3IgYSBmdW5jdGlvbiwgbm90ICcgKyB0eXBlb2Ygc3VwZXJDbGFzcyk7IH0gc3ViQ2xhc3MucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShzdXBlckNsYXNzICYmIHN1cGVyQ2xhc3MucHJvdG90eXBlLCB7IGNvbnN0cnVjdG9yOiB7IHZhbHVlOiBzdWJDbGFzcywgZW51bWVyYWJsZTogZmFsc2UsIHdyaXRhYmxlOiB0cnVlLCBjb25maWd1cmFibGU6IHRydWUgfSB9KTsgaWYgKHN1cGVyQ2xhc3MpIE9iamVjdC5zZXRQcm90b3R5cGVPZiA/IE9iamVjdC5zZXRQcm90b3R5cGVPZihzdWJDbGFzcywgc3VwZXJDbGFzcykgOiBzdWJDbGFzcy5fX3Byb3RvX18gPSBzdXBlckNsYXNzOyB9XG5cbnZhciBfcmVhY3QgPSByZXF1aXJlKCdyZWFjdCcpO1xuXG52YXIgX3JlYWN0MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3JlYWN0KTtcblxudmFyIF9kaXNwb3NhYmxlcyA9IHJlcXVpcmUoJ2Rpc3Bvc2FibGVzJyk7XG5cbnZhciBfdXRpbHNTaGFsbG93RXF1YWwgPSByZXF1aXJlKCcuL3V0aWxzL3NoYWxsb3dFcXVhbCcpO1xuXG52YXIgX3V0aWxzU2hhbGxvd0VxdWFsMiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX3V0aWxzU2hhbGxvd0VxdWFsKTtcblxudmFyIF91dGlsc1NoYWxsb3dFcXVhbFNjYWxhciA9IHJlcXVpcmUoJy4vdXRpbHMvc2hhbGxvd0VxdWFsU2NhbGFyJyk7XG5cbnZhciBfdXRpbHNTaGFsbG93RXF1YWxTY2FsYXIyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfdXRpbHNTaGFsbG93RXF1YWxTY2FsYXIpO1xuXG52YXIgX2xvZGFzaElzUGxhaW5PYmplY3QgPSByZXF1aXJlKCdsb2Rhc2gvaXNQbGFpbk9iamVjdCcpO1xuXG52YXIgX2xvZGFzaElzUGxhaW5PYmplY3QyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNQbGFpbk9iamVjdCk7XG5cbnZhciBfaW52YXJpYW50ID0gcmVxdWlyZSgnaW52YXJpYW50Jyk7XG5cbnZhciBfaW52YXJpYW50MiA9IF9pbnRlcm9wUmVxdWlyZURlZmF1bHQoX2ludmFyaWFudCk7XG5cbmZ1bmN0aW9uIGRlY29yYXRlSGFuZGxlcihfcmVmKSB7XG4gIHZhciBEZWNvcmF0ZWRDb21wb25lbnQgPSBfcmVmLkRlY29yYXRlZENvbXBvbmVudDtcbiAgdmFyIGNyZWF0ZUhhbmRsZXIgPSBfcmVmLmNyZWF0ZUhhbmRsZXI7XG4gIHZhciBjcmVhdGVNb25pdG9yID0gX3JlZi5jcmVhdGVNb25pdG9yO1xuICB2YXIgY3JlYXRlQ29ubmVjdG9yID0gX3JlZi5jcmVhdGVDb25uZWN0b3I7XG4gIHZhciByZWdpc3RlckhhbmRsZXIgPSBfcmVmLnJlZ2lzdGVySGFuZGxlcjtcbiAgdmFyIGNvbnRhaW5lckRpc3BsYXlOYW1lID0gX3JlZi5jb250YWluZXJEaXNwbGF5TmFtZTtcbiAgdmFyIGdldFR5cGUgPSBfcmVmLmdldFR5cGU7XG4gIHZhciBjb2xsZWN0ID0gX3JlZi5jb2xsZWN0O1xuICB2YXIgb3B0aW9ucyA9IF9yZWYub3B0aW9ucztcbiAgdmFyIF9vcHRpb25zJGFyZVByb3BzRXF1YWwgPSBvcHRpb25zLmFyZVByb3BzRXF1YWw7XG4gIHZhciBhcmVQcm9wc0VxdWFsID0gX29wdGlvbnMkYXJlUHJvcHNFcXVhbCA9PT0gdW5kZWZpbmVkID8gX3V0aWxzU2hhbGxvd0VxdWFsU2NhbGFyMlsnZGVmYXVsdCddIDogX29wdGlvbnMkYXJlUHJvcHNFcXVhbDtcblxuICB2YXIgZGlzcGxheU5hbWUgPSBEZWNvcmF0ZWRDb21wb25lbnQuZGlzcGxheU5hbWUgfHwgRGVjb3JhdGVkQ29tcG9uZW50Lm5hbWUgfHwgJ0NvbXBvbmVudCc7XG5cbiAgcmV0dXJuIChmdW5jdGlvbiAoX0NvbXBvbmVudCkge1xuICAgIF9pbmhlcml0cyhEcmFnRHJvcENvbnRhaW5lciwgX0NvbXBvbmVudCk7XG5cbiAgICBEcmFnRHJvcENvbnRhaW5lci5wcm90b3R5cGUuZ2V0SGFuZGxlcklkID0gZnVuY3Rpb24gZ2V0SGFuZGxlcklkKCkge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlcklkO1xuICAgIH07XG5cbiAgICBEcmFnRHJvcENvbnRhaW5lci5wcm90b3R5cGUuZ2V0RGVjb3JhdGVkQ29tcG9uZW50SW5zdGFuY2UgPSBmdW5jdGlvbiBnZXREZWNvcmF0ZWRDb21wb25lbnRJbnN0YW5jZSgpIHtcbiAgICAgIHJldHVybiB0aGlzLmRlY29yYXRlZENvbXBvbmVudEluc3RhbmNlO1xuICAgIH07XG5cbiAgICBEcmFnRHJvcENvbnRhaW5lci5wcm90b3R5cGUuc2hvdWxkQ29tcG9uZW50VXBkYXRlID0gZnVuY3Rpb24gc2hvdWxkQ29tcG9uZW50VXBkYXRlKG5leHRQcm9wcywgbmV4dFN0YXRlKSB7XG4gICAgICByZXR1cm4gIWFyZVByb3BzRXF1YWwobmV4dFByb3BzLCB0aGlzLnByb3BzKSB8fCAhX3V0aWxzU2hhbGxvd0VxdWFsMlsnZGVmYXVsdCddKG5leHRTdGF0ZSwgdGhpcy5zdGF0ZSk7XG4gICAgfTtcblxuICAgIF9jcmVhdGVDbGFzcyhEcmFnRHJvcENvbnRhaW5lciwgbnVsbCwgW3tcbiAgICAgIGtleTogJ0RlY29yYXRlZENvbXBvbmVudCcsXG4gICAgICB2YWx1ZTogRGVjb3JhdGVkQ29tcG9uZW50LFxuICAgICAgZW51bWVyYWJsZTogdHJ1ZVxuICAgIH0sIHtcbiAgICAgIGtleTogJ2Rpc3BsYXlOYW1lJyxcbiAgICAgIHZhbHVlOiBjb250YWluZXJEaXNwbGF5TmFtZSArICcoJyArIGRpc3BsYXlOYW1lICsgJyknLFxuICAgICAgZW51bWVyYWJsZTogdHJ1ZVxuICAgIH0sIHtcbiAgICAgIGtleTogJ2NvbnRleHRUeXBlcycsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBkcmFnRHJvcE1hbmFnZXI6IF9yZWFjdC5Qcm9wVHlwZXMub2JqZWN0LmlzUmVxdWlyZWRcbiAgICAgIH0sXG4gICAgICBlbnVtZXJhYmxlOiB0cnVlXG4gICAgfV0pO1xuXG4gICAgZnVuY3Rpb24gRHJhZ0Ryb3BDb250YWluZXIocHJvcHMsIGNvbnRleHQpIHtcbiAgICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBEcmFnRHJvcENvbnRhaW5lcik7XG5cbiAgICAgIF9Db21wb25lbnQuY2FsbCh0aGlzLCBwcm9wcywgY29udGV4dCk7XG4gICAgICB0aGlzLmhhbmRsZUNoYW5nZSA9IHRoaXMuaGFuZGxlQ2hhbmdlLmJpbmQodGhpcyk7XG4gICAgICB0aGlzLmhhbmRsZUNoaWxkUmVmID0gdGhpcy5oYW5kbGVDaGlsZFJlZi5iaW5kKHRoaXMpO1xuXG4gICAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKHR5cGVvZiB0aGlzLmNvbnRleHQuZHJhZ0Ryb3BNYW5hZ2VyID09PSAnb2JqZWN0JywgJ0NvdWxkIG5vdCBmaW5kIHRoZSBkcmFnIGFuZCBkcm9wIG1hbmFnZXIgaW4gdGhlIGNvbnRleHQgb2YgJXMuICcgKyAnTWFrZSBzdXJlIHRvIHdyYXAgdGhlIHRvcC1sZXZlbCBjb21wb25lbnQgb2YgeW91ciBhcHAgd2l0aCBEcmFnRHJvcENvbnRleHQuICcgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtdHJvdWJsZXNob290aW5nLmh0bWwjY291bGQtbm90LWZpbmQtdGhlLWRyYWctYW5kLWRyb3AtbWFuYWdlci1pbi10aGUtY29udGV4dCcsIGRpc3BsYXlOYW1lLCBkaXNwbGF5TmFtZSk7XG5cbiAgICAgIHRoaXMubWFuYWdlciA9IHRoaXMuY29udGV4dC5kcmFnRHJvcE1hbmFnZXI7XG4gICAgICB0aGlzLmhhbmRsZXJNb25pdG9yID0gY3JlYXRlTW9uaXRvcih0aGlzLm1hbmFnZXIpO1xuICAgICAgdGhpcy5oYW5kbGVyQ29ubmVjdG9yID0gY3JlYXRlQ29ubmVjdG9yKHRoaXMubWFuYWdlci5nZXRCYWNrZW5kKCkpO1xuICAgICAgdGhpcy5oYW5kbGVyID0gY3JlYXRlSGFuZGxlcih0aGlzLmhhbmRsZXJNb25pdG9yKTtcblxuICAgICAgdGhpcy5kaXNwb3NhYmxlID0gbmV3IF9kaXNwb3NhYmxlcy5TZXJpYWxEaXNwb3NhYmxlKCk7XG4gICAgICB0aGlzLnJlY2VpdmVQcm9wcyhwcm9wcyk7XG4gICAgICB0aGlzLnN0YXRlID0gdGhpcy5nZXRDdXJyZW50U3RhdGUoKTtcbiAgICAgIHRoaXMuZGlzcG9zZSgpO1xuICAgIH1cblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5jb21wb25lbnREaWRNb3VudCA9IGZ1bmN0aW9uIGNvbXBvbmVudERpZE1vdW50KCkge1xuICAgICAgdGhpcy5pc0N1cnJlbnRseU1vdW50ZWQgPSB0cnVlO1xuICAgICAgdGhpcy5kaXNwb3NhYmxlID0gbmV3IF9kaXNwb3NhYmxlcy5TZXJpYWxEaXNwb3NhYmxlKCk7XG4gICAgICB0aGlzLmN1cnJlbnRUeXBlID0gbnVsbDtcbiAgICAgIHRoaXMucmVjZWl2ZVByb3BzKHRoaXMucHJvcHMpO1xuICAgICAgdGhpcy5oYW5kbGVDaGFuZ2UoKTtcbiAgICB9O1xuXG4gICAgRHJhZ0Ryb3BDb250YWluZXIucHJvdG90eXBlLmNvbXBvbmVudFdpbGxSZWNlaXZlUHJvcHMgPSBmdW5jdGlvbiBjb21wb25lbnRXaWxsUmVjZWl2ZVByb3BzKG5leHRQcm9wcykge1xuICAgICAgaWYgKCFhcmVQcm9wc0VxdWFsKG5leHRQcm9wcywgdGhpcy5wcm9wcykpIHtcbiAgICAgICAgdGhpcy5yZWNlaXZlUHJvcHMobmV4dFByb3BzKTtcbiAgICAgICAgdGhpcy5oYW5kbGVDaGFuZ2UoKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgRHJhZ0Ryb3BDb250YWluZXIucHJvdG90eXBlLmNvbXBvbmVudFdpbGxVbm1vdW50ID0gZnVuY3Rpb24gY29tcG9uZW50V2lsbFVubW91bnQoKSB7XG4gICAgICB0aGlzLmRpc3Bvc2UoKTtcbiAgICAgIHRoaXMuaXNDdXJyZW50bHlNb3VudGVkID0gZmFsc2U7XG4gICAgfTtcblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5yZWNlaXZlUHJvcHMgPSBmdW5jdGlvbiByZWNlaXZlUHJvcHMocHJvcHMpIHtcbiAgICAgIHRoaXMuaGFuZGxlci5yZWNlaXZlUHJvcHMocHJvcHMpO1xuICAgICAgdGhpcy5yZWNlaXZlVHlwZShnZXRUeXBlKHByb3BzKSk7XG4gICAgfTtcblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5yZWNlaXZlVHlwZSA9IGZ1bmN0aW9uIHJlY2VpdmVUeXBlKHR5cGUpIHtcbiAgICAgIGlmICh0eXBlID09PSB0aGlzLmN1cnJlbnRUeXBlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdGhpcy5jdXJyZW50VHlwZSA9IHR5cGU7XG5cbiAgICAgIHZhciBfcmVnaXN0ZXJIYW5kbGVyID0gcmVnaXN0ZXJIYW5kbGVyKHR5cGUsIHRoaXMuaGFuZGxlciwgdGhpcy5tYW5hZ2VyKTtcblxuICAgICAgdmFyIGhhbmRsZXJJZCA9IF9yZWdpc3RlckhhbmRsZXIuaGFuZGxlcklkO1xuICAgICAgdmFyIHVucmVnaXN0ZXIgPSBfcmVnaXN0ZXJIYW5kbGVyLnVucmVnaXN0ZXI7XG5cbiAgICAgIHRoaXMuaGFuZGxlcklkID0gaGFuZGxlcklkO1xuICAgICAgdGhpcy5oYW5kbGVyTW9uaXRvci5yZWNlaXZlSGFuZGxlcklkKGhhbmRsZXJJZCk7XG4gICAgICB0aGlzLmhhbmRsZXJDb25uZWN0b3IucmVjZWl2ZUhhbmRsZXJJZChoYW5kbGVySWQpO1xuXG4gICAgICB2YXIgZ2xvYmFsTW9uaXRvciA9IHRoaXMubWFuYWdlci5nZXRNb25pdG9yKCk7XG4gICAgICB2YXIgdW5zdWJzY3JpYmUgPSBnbG9iYWxNb25pdG9yLnN1YnNjcmliZVRvU3RhdGVDaGFuZ2UodGhpcy5oYW5kbGVDaGFuZ2UsIHsgaGFuZGxlcklkczogW2hhbmRsZXJJZF0gfSk7XG5cbiAgICAgIHRoaXMuZGlzcG9zYWJsZS5zZXREaXNwb3NhYmxlKG5ldyBfZGlzcG9zYWJsZXMuQ29tcG9zaXRlRGlzcG9zYWJsZShuZXcgX2Rpc3Bvc2FibGVzLkRpc3Bvc2FibGUodW5zdWJzY3JpYmUpLCBuZXcgX2Rpc3Bvc2FibGVzLkRpc3Bvc2FibGUodW5yZWdpc3RlcikpKTtcbiAgICB9O1xuXG4gICAgRHJhZ0Ryb3BDb250YWluZXIucHJvdG90eXBlLmhhbmRsZUNoYW5nZSA9IGZ1bmN0aW9uIGhhbmRsZUNoYW5nZSgpIHtcbiAgICAgIGlmICghdGhpcy5pc0N1cnJlbnRseU1vdW50ZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgbmV4dFN0YXRlID0gdGhpcy5nZXRDdXJyZW50U3RhdGUoKTtcbiAgICAgIGlmICghX3V0aWxzU2hhbGxvd0VxdWFsMlsnZGVmYXVsdCddKG5leHRTdGF0ZSwgdGhpcy5zdGF0ZSkpIHtcbiAgICAgICAgdGhpcy5zZXRTdGF0ZShuZXh0U3RhdGUpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBEcmFnRHJvcENvbnRhaW5lci5wcm90b3R5cGUuZGlzcG9zZSA9IGZ1bmN0aW9uIGRpc3Bvc2UoKSB7XG4gICAgICB0aGlzLmRpc3Bvc2FibGUuZGlzcG9zZSgpO1xuICAgICAgdGhpcy5oYW5kbGVyQ29ubmVjdG9yLnJlY2VpdmVIYW5kbGVySWQobnVsbCk7XG4gICAgfTtcblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5oYW5kbGVDaGlsZFJlZiA9IGZ1bmN0aW9uIGhhbmRsZUNoaWxkUmVmKGNvbXBvbmVudCkge1xuICAgICAgdGhpcy5kZWNvcmF0ZWRDb21wb25lbnRJbnN0YW5jZSA9IGNvbXBvbmVudDtcbiAgICAgIHRoaXMuaGFuZGxlci5yZWNlaXZlQ29tcG9uZW50KGNvbXBvbmVudCk7XG4gICAgfTtcblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5nZXRDdXJyZW50U3RhdGUgPSBmdW5jdGlvbiBnZXRDdXJyZW50U3RhdGUoKSB7XG4gICAgICB2YXIgbmV4dFN0YXRlID0gY29sbGVjdCh0aGlzLmhhbmRsZXJDb25uZWN0b3IuaG9va3MsIHRoaXMuaGFuZGxlck1vbml0b3IpO1xuXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuTk9ERV9FTlYgIT09ICdwcm9kdWN0aW9uJykge1xuICAgICAgICBfaW52YXJpYW50MlsnZGVmYXVsdCddKF9sb2Rhc2hJc1BsYWluT2JqZWN0MlsnZGVmYXVsdCddKG5leHRTdGF0ZSksICdFeHBlY3RlZCBgY29sbGVjdGAgc3BlY2lmaWVkIGFzIHRoZSBzZWNvbmQgYXJndW1lbnQgdG8gJyArICclcyBmb3IgJXMgdG8gcmV0dXJuIGEgcGxhaW4gb2JqZWN0IG9mIHByb3BzIHRvIGluamVjdC4gJyArICdJbnN0ZWFkLCByZWNlaXZlZCAlcy4nLCBjb250YWluZXJEaXNwbGF5TmFtZSwgZGlzcGxheU5hbWUsIG5leHRTdGF0ZSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBuZXh0U3RhdGU7XG4gICAgfTtcblxuICAgIERyYWdEcm9wQ29udGFpbmVyLnByb3RvdHlwZS5yZW5kZXIgPSBmdW5jdGlvbiByZW5kZXIoKSB7XG4gICAgICByZXR1cm4gX3JlYWN0MlsnZGVmYXVsdCddLmNyZWF0ZUVsZW1lbnQoRGVjb3JhdGVkQ29tcG9uZW50LCBfZXh0ZW5kcyh7fSwgdGhpcy5wcm9wcywgdGhpcy5zdGF0ZSwge1xuICAgICAgICByZWY6IHRoaXMuaGFuZGxlQ2hpbGRSZWYgfSkpO1xuICAgIH07XG5cbiAgICByZXR1cm4gRHJhZ0Ryb3BDb250YWluZXI7XG4gIH0pKF9yZWFjdC5Db21wb25lbnQpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZShvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9ialsnZGVmYXVsdCddIDogb2JqOyB9XG5cbnZhciBfRHJhZ0Ryb3BDb250ZXh0ID0gcmVxdWlyZSgnLi9EcmFnRHJvcENvbnRleHQnKTtcblxuZXhwb3J0cy5EcmFnRHJvcENvbnRleHQgPSBfaW50ZXJvcFJlcXVpcmUoX0RyYWdEcm9wQ29udGV4dCk7XG5cbnZhciBfRHJhZ0xheWVyID0gcmVxdWlyZSgnLi9EcmFnTGF5ZXInKTtcblxuZXhwb3J0cy5EcmFnTGF5ZXIgPSBfaW50ZXJvcFJlcXVpcmUoX0RyYWdMYXllcik7XG5cbnZhciBfRHJhZ1NvdXJjZSA9IHJlcXVpcmUoJy4vRHJhZ1NvdXJjZScpO1xuXG5leHBvcnRzLkRyYWdTb3VyY2UgPSBfaW50ZXJvcFJlcXVpcmUoX0RyYWdTb3VyY2UpO1xuXG52YXIgX0Ryb3BUYXJnZXQgPSByZXF1aXJlKCcuL0Ryb3BUYXJnZXQnKTtcblxuZXhwb3J0cy5Ecm9wVGFyZ2V0ID0gX2ludGVyb3BSZXF1aXJlKF9Ecm9wVGFyZ2V0KTsiLCJcInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbXCJkZWZhdWx0XCJdID0gcmVnaXN0ZXJTb3VyY2U7XG5cbmZ1bmN0aW9uIHJlZ2lzdGVyU291cmNlKHR5cGUsIHNvdXJjZSwgbWFuYWdlcikge1xuICB2YXIgcmVnaXN0cnkgPSBtYW5hZ2VyLmdldFJlZ2lzdHJ5KCk7XG4gIHZhciBzb3VyY2VJZCA9IHJlZ2lzdHJ5LmFkZFNvdXJjZSh0eXBlLCBzb3VyY2UpO1xuXG4gIGZ1bmN0aW9uIHVucmVnaXN0ZXJTb3VyY2UoKSB7XG4gICAgcmVnaXN0cnkucmVtb3ZlU291cmNlKHNvdXJjZUlkKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgaGFuZGxlcklkOiBzb3VyY2VJZCxcbiAgICB1bnJlZ2lzdGVyOiB1bnJlZ2lzdGVyU291cmNlXG4gIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1tcImRlZmF1bHRcIl07IiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IHJlZ2lzdGVyVGFyZ2V0O1xuXG5mdW5jdGlvbiByZWdpc3RlclRhcmdldCh0eXBlLCB0YXJnZXQsIG1hbmFnZXIpIHtcbiAgdmFyIHJlZ2lzdHJ5ID0gbWFuYWdlci5nZXRSZWdpc3RyeSgpO1xuICB2YXIgdGFyZ2V0SWQgPSByZWdpc3RyeS5hZGRUYXJnZXQodHlwZSwgdGFyZ2V0KTtcblxuICBmdW5jdGlvbiB1bnJlZ2lzdGVyVGFyZ2V0KCkge1xuICAgIHJlZ2lzdHJ5LnJlbW92ZVRhcmdldCh0YXJnZXRJZCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGhhbmRsZXJJZDogdGFyZ2V0SWQsXG4gICAgdW5yZWdpc3RlcjogdW5yZWdpc3RlclRhcmdldFxuICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbXCJkZWZhdWx0XCJdOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IGNoZWNrRGVjb3JhdG9yQXJndW1lbnRzO1xuXG5mdW5jdGlvbiBjaGVja0RlY29yYXRvckFyZ3VtZW50cyhmdW5jdGlvbk5hbWUsIHNpZ25hdHVyZSkge1xuICBpZiAocHJvY2Vzcy5lbnYuTk9ERV9FTlYgIT09ICdwcm9kdWN0aW9uJykge1xuICAgIGZvciAodmFyIF9sZW4gPSBhcmd1bWVudHMubGVuZ3RoLCBhcmdzID0gQXJyYXkoX2xlbiA+IDIgPyBfbGVuIC0gMiA6IDApLCBfa2V5ID0gMjsgX2tleSA8IF9sZW47IF9rZXkrKykge1xuICAgICAgYXJnc1tfa2V5IC0gMl0gPSBhcmd1bWVudHNbX2tleV07XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgYXJnID0gYXJnc1tpXTtcbiAgICAgIGlmIChhcmcgJiYgYXJnLnByb3RvdHlwZSAmJiBhcmcucHJvdG90eXBlLnJlbmRlcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgJ1lvdSBzZWVtIHRvIGJlIGFwcGx5aW5nIHRoZSBhcmd1bWVudHMgaW4gdGhlIHdyb25nIG9yZGVyLiAnICsgKCdJdCBzaG91bGQgYmUgJyArIGZ1bmN0aW9uTmFtZSArICcoJyArIHNpZ25hdHVyZSArICcpKENvbXBvbmVudCksIG5vdCB0aGUgb3RoZXIgd2F5IGFyb3VuZC4gJykgKyAnUmVhZCBtb3JlOiBodHRwOi8vZ2FlYXJvbi5naXRodWIuaW8vcmVhY3QtZG5kL2RvY3MtdHJvdWJsZXNob290aW5nLmh0bWwjeW91LXNlZW0tdG8tYmUtYXBwbHlpbmctdGhlLWFyZ3VtZW50cy1pbi10aGUtd3Jvbmctb3JkZXInKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBjbG9uZVdpdGhSZWY7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZURlZmF1bHQob2JqKSB7IHJldHVybiBvYmogJiYgb2JqLl9fZXNNb2R1bGUgPyBvYmogOiB7ICdkZWZhdWx0Jzogb2JqIH07IH1cblxudmFyIF9pbnZhcmlhbnQgPSByZXF1aXJlKCdpbnZhcmlhbnQnKTtcblxudmFyIF9pbnZhcmlhbnQyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaW52YXJpYW50KTtcblxudmFyIF9yZWFjdCA9IHJlcXVpcmUoJ3JlYWN0Jyk7XG5cbmZ1bmN0aW9uIGNsb25lV2l0aFJlZihlbGVtZW50LCBuZXdSZWYpIHtcbiAgdmFyIHByZXZpb3VzUmVmID0gZWxlbWVudC5yZWY7XG4gIF9pbnZhcmlhbnQyWydkZWZhdWx0J10odHlwZW9mIHByZXZpb3VzUmVmICE9PSAnc3RyaW5nJywgJ0Nhbm5vdCBjb25uZWN0IFJlYWN0IERuRCB0byBhbiBlbGVtZW50IHdpdGggYW4gZXhpc3Rpbmcgc3RyaW5nIHJlZi4gJyArICdQbGVhc2UgY29udmVydCBpdCB0byB1c2UgYSBjYWxsYmFjayByZWYgaW5zdGVhZCwgb3Igd3JhcCBpdCBpbnRvIGEgPHNwYW4+IG9yIDxkaXY+LiAnICsgJ1JlYWQgbW9yZTogaHR0cHM6Ly9mYWNlYm9vay5naXRodWIuaW8vcmVhY3QvZG9jcy9tb3JlLWFib3V0LXJlZnMuaHRtbCN0aGUtcmVmLWNhbGxiYWNrLWF0dHJpYnV0ZScpO1xuXG4gIGlmICghcHJldmlvdXNSZWYpIHtcbiAgICAvLyBXaGVuIHRoZXJlIGlzIG5vIHJlZiBvbiB0aGUgZWxlbWVudCwgdXNlIHRoZSBuZXcgcmVmIGRpcmVjdGx5XG4gICAgcmV0dXJuIF9yZWFjdC5jbG9uZUVsZW1lbnQoZWxlbWVudCwge1xuICAgICAgcmVmOiBuZXdSZWZcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBfcmVhY3QuY2xvbmVFbGVtZW50KGVsZW1lbnQsIHtcbiAgICByZWY6IGZ1bmN0aW9uIHJlZihub2RlKSB7XG4gICAgICBuZXdSZWYobm9kZSk7XG5cbiAgICAgIGlmIChwcmV2aW91c1JlZikge1xuICAgICAgICBwcmV2aW91c1JlZihub2RlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHNbJ2RlZmF1bHQnXTsiLCIndXNlIHN0cmljdCc7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzWydkZWZhdWx0J10gPSBpc1ZhbGlkVHlwZTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG52YXIgX2xvZGFzaElzQXJyYXkgPSByZXF1aXJlKCdsb2Rhc2gvaXNBcnJheScpO1xuXG52YXIgX2xvZGFzaElzQXJyYXkyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfbG9kYXNoSXNBcnJheSk7XG5cbmZ1bmN0aW9uIGlzVmFsaWRUeXBlKHR5cGUsIGFsbG93QXJyYXkpIHtcbiAgICAgICByZXR1cm4gdHlwZW9mIHR5cGUgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiB0eXBlID09PSAnc3ltYm9sJyB8fCBhbGxvd0FycmF5ICYmIF9sb2Rhc2hJc0FycmF5MlsnZGVmYXVsdCddKHR5cGUpICYmIHR5cGUuZXZlcnkoZnVuY3Rpb24gKHQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIGlzVmFsaWRUeXBlKHQsIGZhbHNlKTtcbiAgICAgICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0c1snZGVmYXVsdCddID0gc2hhbGxvd0VxdWFsU2NhbGFyO1xuXG5mdW5jdGlvbiBzaGFsbG93RXF1YWxTY2FsYXIob2JqQSwgb2JqQikge1xuICBpZiAob2JqQSA9PT0gb2JqQikge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmpBICE9PSAnb2JqZWN0JyB8fCBvYmpBID09PSBudWxsIHx8IHR5cGVvZiBvYmpCICE9PSAnb2JqZWN0JyB8fCBvYmpCID09PSBudWxsKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgdmFyIGtleXNBID0gT2JqZWN0LmtleXMob2JqQSk7XG4gIHZhciBrZXlzQiA9IE9iamVjdC5rZXlzKG9iakIpO1xuXG4gIGlmIChrZXlzQS5sZW5ndGggIT09IGtleXNCLmxlbmd0aCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFRlc3QgZm9yIEEncyBrZXlzIGRpZmZlcmVudCBmcm9tIEIuXG4gIHZhciBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5O1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGtleXNBLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKCFoYXNPd24uY2FsbChvYmpCLCBrZXlzQVtpXSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB2YXIgdmFsQSA9IG9iakFba2V5c0FbaV1dO1xuICAgIHZhciB2YWxCID0gb2JqQltrZXlzQVtpXV07XG5cbiAgICBpZiAodmFsQSAhPT0gdmFsQiB8fCB0eXBlb2YgdmFsQSA9PT0gJ29iamVjdCcgfHwgdHlwZW9mIHZhbEIgPT09ICdvYmplY3QnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZXhwb3J0c1snZGVmYXVsdCddOyIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHNbJ2RlZmF1bHQnXSA9IHdyYXBDb25uZWN0b3JIb29rcztcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgJ2RlZmF1bHQnOiBvYmogfTsgfVxuXG52YXIgX3V0aWxzQ2xvbmVXaXRoUmVmID0gcmVxdWlyZSgnLi91dGlscy9jbG9uZVdpdGhSZWYnKTtcblxudmFyIF91dGlsc0Nsb25lV2l0aFJlZjIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF91dGlsc0Nsb25lV2l0aFJlZik7XG5cbnZhciBfcmVhY3QgPSByZXF1aXJlKCdyZWFjdCcpO1xuXG5mdW5jdGlvbiB0aHJvd0lmQ29tcG9zaXRlQ29tcG9uZW50RWxlbWVudChlbGVtZW50KSB7XG4gIC8vIEN1c3RvbSBjb21wb25lbnRzIGNhbiBubyBsb25nZXIgYmUgd3JhcHBlZCBkaXJlY3RseSBpbiBSZWFjdCBEbkQgMi4wXG4gIC8vIHNvIHRoYXQgd2UgZG9uJ3QgbmVlZCB0byBkZXBlbmQgb24gZmluZERPTU5vZGUoKSBmcm9tIHJlYWN0LWRvbS5cbiAgaWYgKHR5cGVvZiBlbGVtZW50LnR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIGRpc3BsYXlOYW1lID0gZWxlbWVudC50eXBlLmRpc3BsYXlOYW1lIHx8IGVsZW1lbnQudHlwZS5uYW1lIHx8ICd0aGUgY29tcG9uZW50JztcblxuICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgbmF0aXZlIGVsZW1lbnQgbm9kZXMgY2FuIG5vdyBiZSBwYXNzZWQgdG8gUmVhY3QgRG5EIGNvbm5lY3RvcnMuICcgKyAoJ1lvdSBjYW4gZWl0aGVyIHdyYXAgJyArIGRpc3BsYXlOYW1lICsgJyBpbnRvIGEgPGRpdj4sIG9yIHR1cm4gaXQgaW50byBhICcpICsgJ2RyYWcgc291cmNlIG9yIGEgZHJvcCB0YXJnZXQgaXRzZWxmLicpO1xufVxuXG5mdW5jdGlvbiB3cmFwSG9va1RvUmVjb2duaXplRWxlbWVudChob29rKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGVsZW1lbnRPck5vZGUgPSBhcmd1bWVudHMubGVuZ3RoIDw9IDAgfHwgYXJndW1lbnRzWzBdID09PSB1bmRlZmluZWQgPyBudWxsIDogYXJndW1lbnRzWzBdO1xuICAgIHZhciBvcHRpb25zID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8gbnVsbCA6IGFyZ3VtZW50c1sxXTtcblxuICAgIC8vIFdoZW4gcGFzc2VkIGEgbm9kZSwgY2FsbCB0aGUgaG9vayBzdHJhaWdodCBhd2F5LlxuICAgIGlmICghX3JlYWN0LmlzVmFsaWRFbGVtZW50KGVsZW1lbnRPck5vZGUpKSB7XG4gICAgICB2YXIgbm9kZSA9IGVsZW1lbnRPck5vZGU7XG4gICAgICBob29rKG5vZGUsIG9wdGlvbnMpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIElmIHBhc3NlZCBhIFJlYWN0RWxlbWVudCwgY2xvbmUgaXQgYW5kIGF0dGFjaCB0aGlzIGZ1bmN0aW9uIGFzIGEgcmVmLlxuICAgIC8vIFRoaXMgaGVscHMgdXMgYWNoaWV2ZSBhIG5lYXQgQVBJIHdoZXJlIHVzZXIgZG9lc24ndCBldmVuIGtub3cgdGhhdCByZWZzXG4gICAgLy8gYXJlIGJlaW5nIHVzZWQgdW5kZXIgdGhlIGhvb2QuXG4gICAgdmFyIGVsZW1lbnQgPSBlbGVtZW50T3JOb2RlO1xuICAgIHRocm93SWZDb21wb3NpdGVDb21wb25lbnRFbGVtZW50KGVsZW1lbnQpO1xuXG4gICAgLy8gV2hlbiBubyBvcHRpb25zIGFyZSBwYXNzZWQsIHVzZSB0aGUgaG9vayBkaXJlY3RseVxuICAgIHZhciByZWYgPSBvcHRpb25zID8gZnVuY3Rpb24gKG5vZGUpIHtcbiAgICAgIHJldHVybiBob29rKG5vZGUsIG9wdGlvbnMpO1xuICAgIH0gOiBob29rO1xuXG4gICAgcmV0dXJuIF91dGlsc0Nsb25lV2l0aFJlZjJbJ2RlZmF1bHQnXShlbGVtZW50LCByZWYpO1xuICB9O1xufVxuXG5mdW5jdGlvbiB3cmFwQ29ubmVjdG9ySG9va3MoaG9va3MpIHtcbiAgdmFyIHdyYXBwZWRIb29rcyA9IHt9O1xuXG4gIE9iamVjdC5rZXlzKGhvb2tzKS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHtcbiAgICB2YXIgaG9vayA9IGhvb2tzW2tleV07XG4gICAgdmFyIHdyYXBwZWRIb29rID0gd3JhcEhvb2tUb1JlY29nbml6ZUVsZW1lbnQoaG9vayk7XG4gICAgd3JhcHBlZEhvb2tzW2tleV0gPSBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gd3JhcHBlZEhvb2s7XG4gICAgfTtcbiAgfSk7XG5cbiAgcmV0dXJuIHdyYXBwZWRIb29rcztcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzWydkZWZhdWx0J107IiwiLyogQnVpbHQtaW4gbWV0aG9kIHJlZmVyZW5jZXMgZm9yIHRob3NlIHdpdGggdGhlIHNhbWUgbmFtZSBhcyBvdGhlciBgbG9kYXNoYCBtZXRob2RzLiAqL1xudmFyIG5hdGl2ZUdldFByb3RvdHlwZSA9IE9iamVjdC5nZXRQcm90b3R5cGVPZjtcblxuLyoqXG4gKiBHZXRzIHRoZSBgW1tQcm90b3R5cGVdXWAgb2YgYHZhbHVlYC5cbiAqXG4gKiBAcHJpdmF0ZVxuICogQHBhcmFtIHsqfSB2YWx1ZSBUaGUgdmFsdWUgdG8gcXVlcnkuXG4gKiBAcmV0dXJucyB7bnVsbHxPYmplY3R9IFJldHVybnMgdGhlIGBbW1Byb3RvdHlwZV1dYC5cbiAqL1xuZnVuY3Rpb24gZ2V0UHJvdG90eXBlKHZhbHVlKSB7XG4gIHJldHVybiBuYXRpdmVHZXRQcm90b3R5cGUoT2JqZWN0KHZhbHVlKSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZ2V0UHJvdG90eXBlO1xuIiwidmFyIGdldFByb3RvdHlwZSA9IHJlcXVpcmUoJy4vX2dldFByb3RvdHlwZScpLFxuICAgIGlzSG9zdE9iamVjdCA9IHJlcXVpcmUoJy4vX2lzSG9zdE9iamVjdCcpLFxuICAgIGlzT2JqZWN0TGlrZSA9IHJlcXVpcmUoJy4vaXNPYmplY3RMaWtlJyk7XG5cbi8qKiBgT2JqZWN0I3RvU3RyaW5nYCByZXN1bHQgcmVmZXJlbmNlcy4gKi9cbnZhciBvYmplY3RUYWcgPSAnW29iamVjdCBPYmplY3RdJztcblxuLyoqIFVzZWQgZm9yIGJ1aWx0LWluIG1ldGhvZCByZWZlcmVuY2VzLiAqL1xudmFyIG9iamVjdFByb3RvID0gT2JqZWN0LnByb3RvdHlwZTtcblxuLyoqIFVzZWQgdG8gcmVzb2x2ZSB0aGUgZGVjb21waWxlZCBzb3VyY2Ugb2YgZnVuY3Rpb25zLiAqL1xudmFyIGZ1bmNUb1N0cmluZyA9IEZ1bmN0aW9uLnByb3RvdHlwZS50b1N0cmluZztcblxuLyoqIFVzZWQgdG8gY2hlY2sgb2JqZWN0cyBmb3Igb3duIHByb3BlcnRpZXMuICovXG52YXIgaGFzT3duUHJvcGVydHkgPSBvYmplY3RQcm90by5oYXNPd25Qcm9wZXJ0eTtcblxuLyoqIFVzZWQgdG8gaW5mZXIgdGhlIGBPYmplY3RgIGNvbnN0cnVjdG9yLiAqL1xudmFyIG9iamVjdEN0b3JTdHJpbmcgPSBmdW5jVG9TdHJpbmcuY2FsbChPYmplY3QpO1xuXG4vKipcbiAqIFVzZWQgdG8gcmVzb2x2ZSB0aGVcbiAqIFtgdG9TdHJpbmdUYWdgXShodHRwOi8vZWNtYS1pbnRlcm5hdGlvbmFsLm9yZy9lY21hLTI2Mi82LjAvI3NlYy1vYmplY3QucHJvdG90eXBlLnRvc3RyaW5nKVxuICogb2YgdmFsdWVzLlxuICovXG52YXIgb2JqZWN0VG9TdHJpbmcgPSBvYmplY3RQcm90by50b1N0cmluZztcblxuLyoqXG4gKiBDaGVja3MgaWYgYHZhbHVlYCBpcyBhIHBsYWluIG9iamVjdCwgdGhhdCBpcywgYW4gb2JqZWN0IGNyZWF0ZWQgYnkgdGhlXG4gKiBgT2JqZWN0YCBjb25zdHJ1Y3RvciBvciBvbmUgd2l0aCBhIGBbW1Byb3RvdHlwZV1dYCBvZiBgbnVsbGAuXG4gKlxuICogQHN0YXRpY1xuICogQG1lbWJlck9mIF9cbiAqIEBzaW5jZSAwLjguMFxuICogQGNhdGVnb3J5IExhbmdcbiAqIEBwYXJhbSB7Kn0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybnMgYHRydWVgIGlmIGB2YWx1ZWAgaXMgYSBwbGFpbiBvYmplY3QsXG4gKiAgZWxzZSBgZmFsc2VgLlxuICogQGV4YW1wbGVcbiAqXG4gKiBmdW5jdGlvbiBGb28oKSB7XG4gKiAgIHRoaXMuYSA9IDE7XG4gKiB9XG4gKlxuICogXy5pc1BsYWluT2JqZWN0KG5ldyBGb28pO1xuICogLy8gPT4gZmFsc2VcbiAqXG4gKiBfLmlzUGxhaW5PYmplY3QoWzEsIDIsIDNdKTtcbiAqIC8vID0+IGZhbHNlXG4gKlxuICogXy5pc1BsYWluT2JqZWN0KHsgJ3gnOiAwLCAneSc6IDAgfSk7XG4gKiAvLyA9PiB0cnVlXG4gKlxuICogXy5pc1BsYWluT2JqZWN0KE9iamVjdC5jcmVhdGUobnVsbCkpO1xuICogLy8gPT4gdHJ1ZVxuICovXG5mdW5jdGlvbiBpc1BsYWluT2JqZWN0KHZhbHVlKSB7XG4gIGlmICghaXNPYmplY3RMaWtlKHZhbHVlKSB8fFxuICAgICAgb2JqZWN0VG9TdHJpbmcuY2FsbCh2YWx1ZSkgIT0gb2JqZWN0VGFnIHx8IGlzSG9zdE9iamVjdCh2YWx1ZSkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdmFyIHByb3RvID0gZ2V0UHJvdG90eXBlKHZhbHVlKTtcbiAgaWYgKHByb3RvID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgdmFyIEN0b3IgPSBoYXNPd25Qcm9wZXJ0eS5jYWxsKHByb3RvLCAnY29uc3RydWN0b3InKSAmJiBwcm90by5jb25zdHJ1Y3RvcjtcbiAgcmV0dXJuICh0eXBlb2YgQ3RvciA9PSAnZnVuY3Rpb24nICYmXG4gICAgQ3RvciBpbnN0YW5jZW9mIEN0b3IgJiYgZnVuY1RvU3RyaW5nLmNhbGwoQ3RvcikgPT0gb2JqZWN0Q3RvclN0cmluZyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gaXNQbGFpbk9iamVjdDtcbiIsIid1c2Ugc3RyaWN0JztcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuQWN0aW9uVHlwZXMgPSB1bmRlZmluZWQ7XG5leHBvcnRzW1wiZGVmYXVsdFwiXSA9IGNyZWF0ZVN0b3JlO1xuXG52YXIgX2lzUGxhaW5PYmplY3QgPSByZXF1aXJlKCdsb2Rhc2gvaXNQbGFpbk9iamVjdCcpO1xuXG52YXIgX2lzUGxhaW5PYmplY3QyID0gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChfaXNQbGFpbk9iamVjdCk7XG5cbnZhciBfc3ltYm9sT2JzZXJ2YWJsZSA9IHJlcXVpcmUoJ3N5bWJvbC1vYnNlcnZhYmxlJyk7XG5cbnZhciBfc3ltYm9sT2JzZXJ2YWJsZTIgPSBfaW50ZXJvcFJlcXVpcmVEZWZhdWx0KF9zeW1ib2xPYnNlcnZhYmxlKTtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlRGVmYXVsdChvYmopIHsgcmV0dXJuIG9iaiAmJiBvYmouX19lc01vZHVsZSA/IG9iaiA6IHsgXCJkZWZhdWx0XCI6IG9iaiB9OyB9XG5cbi8qKlxuICogVGhlc2UgYXJlIHByaXZhdGUgYWN0aW9uIHR5cGVzIHJlc2VydmVkIGJ5IFJlZHV4LlxuICogRm9yIGFueSB1bmtub3duIGFjdGlvbnMsIHlvdSBtdXN0IHJldHVybiB0aGUgY3VycmVudCBzdGF0ZS5cbiAqIElmIHRoZSBjdXJyZW50IHN0YXRlIGlzIHVuZGVmaW5lZCwgeW91IG11c3QgcmV0dXJuIHRoZSBpbml0aWFsIHN0YXRlLlxuICogRG8gbm90IHJlZmVyZW5jZSB0aGVzZSBhY3Rpb24gdHlwZXMgZGlyZWN0bHkgaW4geW91ciBjb2RlLlxuICovXG52YXIgQWN0aW9uVHlwZXMgPSBleHBvcnRzLkFjdGlvblR5cGVzID0ge1xuICBJTklUOiAnQEByZWR1eC9JTklUJ1xufTtcblxuLyoqXG4gKiBDcmVhdGVzIGEgUmVkdXggc3RvcmUgdGhhdCBob2xkcyB0aGUgc3RhdGUgdHJlZS5cbiAqIFRoZSBvbmx5IHdheSB0byBjaGFuZ2UgdGhlIGRhdGEgaW4gdGhlIHN0b3JlIGlzIHRvIGNhbGwgYGRpc3BhdGNoKClgIG9uIGl0LlxuICpcbiAqIFRoZXJlIHNob3VsZCBvbmx5IGJlIGEgc2luZ2xlIHN0b3JlIGluIHlvdXIgYXBwLiBUbyBzcGVjaWZ5IGhvdyBkaWZmZXJlbnRcbiAqIHBhcnRzIG9mIHRoZSBzdGF0ZSB0cmVlIHJlc3BvbmQgdG8gYWN0aW9ucywgeW91IG1heSBjb21iaW5lIHNldmVyYWwgcmVkdWNlcnNcbiAqIGludG8gYSBzaW5nbGUgcmVkdWNlciBmdW5jdGlvbiBieSB1c2luZyBgY29tYmluZVJlZHVjZXJzYC5cbiAqXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSByZWR1Y2VyIEEgZnVuY3Rpb24gdGhhdCByZXR1cm5zIHRoZSBuZXh0IHN0YXRlIHRyZWUsIGdpdmVuXG4gKiB0aGUgY3VycmVudCBzdGF0ZSB0cmVlIGFuZCB0aGUgYWN0aW9uIHRvIGhhbmRsZS5cbiAqXG4gKiBAcGFyYW0ge2FueX0gW2luaXRpYWxTdGF0ZV0gVGhlIGluaXRpYWwgc3RhdGUuIFlvdSBtYXkgb3B0aW9uYWxseSBzcGVjaWZ5IGl0XG4gKiB0byBoeWRyYXRlIHRoZSBzdGF0ZSBmcm9tIHRoZSBzZXJ2ZXIgaW4gdW5pdmVyc2FsIGFwcHMsIG9yIHRvIHJlc3RvcmUgYVxuICogcHJldmlvdXNseSBzZXJpYWxpemVkIHVzZXIgc2Vzc2lvbi5cbiAqIElmIHlvdSB1c2UgYGNvbWJpbmVSZWR1Y2Vyc2AgdG8gcHJvZHVjZSB0aGUgcm9vdCByZWR1Y2VyIGZ1bmN0aW9uLCB0aGlzIG11c3QgYmVcbiAqIGFuIG9iamVjdCB3aXRoIHRoZSBzYW1lIHNoYXBlIGFzIGBjb21iaW5lUmVkdWNlcnNgIGtleXMuXG4gKlxuICogQHBhcmFtIHtGdW5jdGlvbn0gZW5oYW5jZXIgVGhlIHN0b3JlIGVuaGFuY2VyLiBZb3UgbWF5IG9wdGlvbmFsbHkgc3BlY2lmeSBpdFxuICogdG8gZW5oYW5jZSB0aGUgc3RvcmUgd2l0aCB0aGlyZC1wYXJ0eSBjYXBhYmlsaXRpZXMgc3VjaCBhcyBtaWRkbGV3YXJlLFxuICogdGltZSB0cmF2ZWwsIHBlcnNpc3RlbmNlLCBldGMuIFRoZSBvbmx5IHN0b3JlIGVuaGFuY2VyIHRoYXQgc2hpcHMgd2l0aCBSZWR1eFxuICogaXMgYGFwcGx5TWlkZGxld2FyZSgpYC5cbiAqXG4gKiBAcmV0dXJucyB7U3RvcmV9IEEgUmVkdXggc3RvcmUgdGhhdCBsZXRzIHlvdSByZWFkIHRoZSBzdGF0ZSwgZGlzcGF0Y2ggYWN0aW9uc1xuICogYW5kIHN1YnNjcmliZSB0byBjaGFuZ2VzLlxuICovXG5mdW5jdGlvbiBjcmVhdGVTdG9yZShyZWR1Y2VyLCBpbml0aWFsU3RhdGUsIGVuaGFuY2VyKSB7XG4gIHZhciBfcmVmMjtcblxuICBpZiAodHlwZW9mIGluaXRpYWxTdGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiB0eXBlb2YgZW5oYW5jZXIgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgZW5oYW5jZXIgPSBpbml0aWFsU3RhdGU7XG4gICAgaW5pdGlhbFN0YXRlID0gdW5kZWZpbmVkO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBlbmhhbmNlciAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBpZiAodHlwZW9mIGVuaGFuY2VyICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0V4cGVjdGVkIHRoZSBlbmhhbmNlciB0byBiZSBhIGZ1bmN0aW9uLicpO1xuICAgIH1cblxuICAgIHJldHVybiBlbmhhbmNlcihjcmVhdGVTdG9yZSkocmVkdWNlciwgaW5pdGlhbFN0YXRlKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgcmVkdWNlciAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IG5ldyBFcnJvcignRXhwZWN0ZWQgdGhlIHJlZHVjZXIgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgfVxuXG4gIHZhciBjdXJyZW50UmVkdWNlciA9IHJlZHVjZXI7XG4gIHZhciBjdXJyZW50U3RhdGUgPSBpbml0aWFsU3RhdGU7XG4gIHZhciBjdXJyZW50TGlzdGVuZXJzID0gW107XG4gIHZhciBuZXh0TGlzdGVuZXJzID0gY3VycmVudExpc3RlbmVycztcbiAgdmFyIGlzRGlzcGF0Y2hpbmcgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBlbnN1cmVDYW5NdXRhdGVOZXh0TGlzdGVuZXJzKCkge1xuICAgIGlmIChuZXh0TGlzdGVuZXJzID09PSBjdXJyZW50TGlzdGVuZXJzKSB7XG4gICAgICBuZXh0TGlzdGVuZXJzID0gY3VycmVudExpc3RlbmVycy5zbGljZSgpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZWFkcyB0aGUgc3RhdGUgdHJlZSBtYW5hZ2VkIGJ5IHRoZSBzdG9yZS5cbiAgICpcbiAgICogQHJldHVybnMge2FueX0gVGhlIGN1cnJlbnQgc3RhdGUgdHJlZSBvZiB5b3VyIGFwcGxpY2F0aW9uLlxuICAgKi9cbiAgZnVuY3Rpb24gZ2V0U3RhdGUoKSB7XG4gICAgcmV0dXJuIGN1cnJlbnRTdGF0ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGRzIGEgY2hhbmdlIGxpc3RlbmVyLiBJdCB3aWxsIGJlIGNhbGxlZCBhbnkgdGltZSBhbiBhY3Rpb24gaXMgZGlzcGF0Y2hlZCxcbiAgICogYW5kIHNvbWUgcGFydCBvZiB0aGUgc3RhdGUgdHJlZSBtYXkgcG90ZW50aWFsbHkgaGF2ZSBjaGFuZ2VkLiBZb3UgbWF5IHRoZW5cbiAgICogY2FsbCBgZ2V0U3RhdGUoKWAgdG8gcmVhZCB0aGUgY3VycmVudCBzdGF0ZSB0cmVlIGluc2lkZSB0aGUgY2FsbGJhY2suXG4gICAqXG4gICAqIFlvdSBtYXkgY2FsbCBgZGlzcGF0Y2goKWAgZnJvbSBhIGNoYW5nZSBsaXN0ZW5lciwgd2l0aCB0aGUgZm9sbG93aW5nXG4gICAqIGNhdmVhdHM6XG4gICAqXG4gICAqIDEuIFRoZSBzdWJzY3JpcHRpb25zIGFyZSBzbmFwc2hvdHRlZCBqdXN0IGJlZm9yZSBldmVyeSBgZGlzcGF0Y2goKWAgY2FsbC5cbiAgICogSWYgeW91IHN1YnNjcmliZSBvciB1bnN1YnNjcmliZSB3aGlsZSB0aGUgbGlzdGVuZXJzIGFyZSBiZWluZyBpbnZva2VkLCB0aGlzXG4gICAqIHdpbGwgbm90IGhhdmUgYW55IGVmZmVjdCBvbiB0aGUgYGRpc3BhdGNoKClgIHRoYXQgaXMgY3VycmVudGx5IGluIHByb2dyZXNzLlxuICAgKiBIb3dldmVyLCB0aGUgbmV4dCBgZGlzcGF0Y2goKWAgY2FsbCwgd2hldGhlciBuZXN0ZWQgb3Igbm90LCB3aWxsIHVzZSBhIG1vcmVcbiAgICogcmVjZW50IHNuYXBzaG90IG9mIHRoZSBzdWJzY3JpcHRpb24gbGlzdC5cbiAgICpcbiAgICogMi4gVGhlIGxpc3RlbmVyIHNob3VsZCBub3QgZXhwZWN0IHRvIHNlZSBhbGwgc3RhdGUgY2hhbmdlcywgYXMgdGhlIHN0YXRlXG4gICAqIG1pZ2h0IGhhdmUgYmVlbiB1cGRhdGVkIG11bHRpcGxlIHRpbWVzIGR1cmluZyBhIG5lc3RlZCBgZGlzcGF0Y2goKWAgYmVmb3JlXG4gICAqIHRoZSBsaXN0ZW5lciBpcyBjYWxsZWQuIEl0IGlzLCBob3dldmVyLCBndWFyYW50ZWVkIHRoYXQgYWxsIHN1YnNjcmliZXJzXG4gICAqIHJlZ2lzdGVyZWQgYmVmb3JlIHRoZSBgZGlzcGF0Y2goKWAgc3RhcnRlZCB3aWxsIGJlIGNhbGxlZCB3aXRoIHRoZSBsYXRlc3RcbiAgICogc3RhdGUgYnkgdGhlIHRpbWUgaXQgZXhpdHMuXG4gICAqXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGxpc3RlbmVyIEEgY2FsbGJhY2sgdG8gYmUgaW52b2tlZCBvbiBldmVyeSBkaXNwYXRjaC5cbiAgICogQHJldHVybnMge0Z1bmN0aW9ufSBBIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGlzIGNoYW5nZSBsaXN0ZW5lci5cbiAgICovXG4gIGZ1bmN0aW9uIHN1YnNjcmliZShsaXN0ZW5lcikge1xuICAgIGlmICh0eXBlb2YgbGlzdGVuZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRXhwZWN0ZWQgbGlzdGVuZXIgdG8gYmUgYSBmdW5jdGlvbi4nKTtcbiAgICB9XG5cbiAgICB2YXIgaXNTdWJzY3JpYmVkID0gdHJ1ZTtcblxuICAgIGVuc3VyZUNhbk11dGF0ZU5leHRMaXN0ZW5lcnMoKTtcbiAgICBuZXh0TGlzdGVuZXJzLnB1c2gobGlzdGVuZXIpO1xuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIHVuc3Vic2NyaWJlKCkge1xuICAgICAgaWYgKCFpc1N1YnNjcmliZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpc1N1YnNjcmliZWQgPSBmYWxzZTtcblxuICAgICAgZW5zdXJlQ2FuTXV0YXRlTmV4dExpc3RlbmVycygpO1xuICAgICAgdmFyIGluZGV4ID0gbmV4dExpc3RlbmVycy5pbmRleE9mKGxpc3RlbmVyKTtcbiAgICAgIG5leHRMaXN0ZW5lcnMuc3BsaWNlKGluZGV4LCAxKTtcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIERpc3BhdGNoZXMgYW4gYWN0aW9uLiBJdCBpcyB0aGUgb25seSB3YXkgdG8gdHJpZ2dlciBhIHN0YXRlIGNoYW5nZS5cbiAgICpcbiAgICogVGhlIGByZWR1Y2VyYCBmdW5jdGlvbiwgdXNlZCB0byBjcmVhdGUgdGhlIHN0b3JlLCB3aWxsIGJlIGNhbGxlZCB3aXRoIHRoZVxuICAgKiBjdXJyZW50IHN0YXRlIHRyZWUgYW5kIHRoZSBnaXZlbiBgYWN0aW9uYC4gSXRzIHJldHVybiB2YWx1ZSB3aWxsXG4gICAqIGJlIGNvbnNpZGVyZWQgdGhlICoqbmV4dCoqIHN0YXRlIG9mIHRoZSB0cmVlLCBhbmQgdGhlIGNoYW5nZSBsaXN0ZW5lcnNcbiAgICogd2lsbCBiZSBub3RpZmllZC5cbiAgICpcbiAgICogVGhlIGJhc2UgaW1wbGVtZW50YXRpb24gb25seSBzdXBwb3J0cyBwbGFpbiBvYmplY3QgYWN0aW9ucy4gSWYgeW91IHdhbnQgdG9cbiAgICogZGlzcGF0Y2ggYSBQcm9taXNlLCBhbiBPYnNlcnZhYmxlLCBhIHRodW5rLCBvciBzb21ldGhpbmcgZWxzZSwgeW91IG5lZWQgdG9cbiAgICogd3JhcCB5b3VyIHN0b3JlIGNyZWF0aW5nIGZ1bmN0aW9uIGludG8gdGhlIGNvcnJlc3BvbmRpbmcgbWlkZGxld2FyZS4gRm9yXG4gICAqIGV4YW1wbGUsIHNlZSB0aGUgZG9jdW1lbnRhdGlvbiBmb3IgdGhlIGByZWR1eC10aHVua2AgcGFja2FnZS4gRXZlbiB0aGVcbiAgICogbWlkZGxld2FyZSB3aWxsIGV2ZW50dWFsbHkgZGlzcGF0Y2ggcGxhaW4gb2JqZWN0IGFjdGlvbnMgdXNpbmcgdGhpcyBtZXRob2QuXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBhY3Rpb24gQSBwbGFpbiBvYmplY3QgcmVwcmVzZW50aW5nIOKAnHdoYXQgY2hhbmdlZOKAnS4gSXQgaXNcbiAgICogYSBnb29kIGlkZWEgdG8ga2VlcCBhY3Rpb25zIHNlcmlhbGl6YWJsZSBzbyB5b3UgY2FuIHJlY29yZCBhbmQgcmVwbGF5IHVzZXJcbiAgICogc2Vzc2lvbnMsIG9yIHVzZSB0aGUgdGltZSB0cmF2ZWxsaW5nIGByZWR1eC1kZXZ0b29sc2AuIEFuIGFjdGlvbiBtdXN0IGhhdmVcbiAgICogYSBgdHlwZWAgcHJvcGVydHkgd2hpY2ggbWF5IG5vdCBiZSBgdW5kZWZpbmVkYC4gSXQgaXMgYSBnb29kIGlkZWEgdG8gdXNlXG4gICAqIHN0cmluZyBjb25zdGFudHMgZm9yIGFjdGlvbiB0eXBlcy5cbiAgICpcbiAgICogQHJldHVybnMge09iamVjdH0gRm9yIGNvbnZlbmllbmNlLCB0aGUgc2FtZSBhY3Rpb24gb2JqZWN0IHlvdSBkaXNwYXRjaGVkLlxuICAgKlxuICAgKiBOb3RlIHRoYXQsIGlmIHlvdSB1c2UgYSBjdXN0b20gbWlkZGxld2FyZSwgaXQgbWF5IHdyYXAgYGRpc3BhdGNoKClgIHRvXG4gICAqIHJldHVybiBzb21ldGhpbmcgZWxzZSAoZm9yIGV4YW1wbGUsIGEgUHJvbWlzZSB5b3UgY2FuIGF3YWl0KS5cbiAgICovXG4gIGZ1bmN0aW9uIGRpc3BhdGNoKGFjdGlvbikge1xuICAgIGlmICghKDAsIF9pc1BsYWluT2JqZWN0MltcImRlZmF1bHRcIl0pKGFjdGlvbikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQWN0aW9ucyBtdXN0IGJlIHBsYWluIG9iamVjdHMuICcgKyAnVXNlIGN1c3RvbSBtaWRkbGV3YXJlIGZvciBhc3luYyBhY3Rpb25zLicpO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgYWN0aW9uLnR5cGUgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FjdGlvbnMgbWF5IG5vdCBoYXZlIGFuIHVuZGVmaW5lZCBcInR5cGVcIiBwcm9wZXJ0eS4gJyArICdIYXZlIHlvdSBtaXNzcGVsbGVkIGEgY29uc3RhbnQ/Jyk7XG4gICAgfVxuXG4gICAgaWYgKGlzRGlzcGF0Y2hpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignUmVkdWNlcnMgbWF5IG5vdCBkaXNwYXRjaCBhY3Rpb25zLicpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBpc0Rpc3BhdGNoaW5nID0gdHJ1ZTtcbiAgICAgIGN1cnJlbnRTdGF0ZSA9IGN1cnJlbnRSZWR1Y2VyKGN1cnJlbnRTdGF0ZSwgYWN0aW9uKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaXNEaXNwYXRjaGluZyA9IGZhbHNlO1xuICAgIH1cblxuICAgIHZhciBsaXN0ZW5lcnMgPSBjdXJyZW50TGlzdGVuZXJzID0gbmV4dExpc3RlbmVycztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpc3RlbmVycy5sZW5ndGg7IGkrKykge1xuICAgICAgbGlzdGVuZXJzW2ldKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGFjdGlvbjtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXBsYWNlcyB0aGUgcmVkdWNlciBjdXJyZW50bHkgdXNlZCBieSB0aGUgc3RvcmUgdG8gY2FsY3VsYXRlIHRoZSBzdGF0ZS5cbiAgICpcbiAgICogWW91IG1pZ2h0IG5lZWQgdGhpcyBpZiB5b3VyIGFwcCBpbXBsZW1lbnRzIGNvZGUgc3BsaXR0aW5nIGFuZCB5b3Ugd2FudCB0b1xuICAgKiBsb2FkIHNvbWUgb2YgdGhlIHJlZHVjZXJzIGR5bmFtaWNhbGx5LiBZb3UgbWlnaHQgYWxzbyBuZWVkIHRoaXMgaWYgeW91XG4gICAqIGltcGxlbWVudCBhIGhvdCByZWxvYWRpbmcgbWVjaGFuaXNtIGZvciBSZWR1eC5cbiAgICpcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gbmV4dFJlZHVjZXIgVGhlIHJlZHVjZXIgZm9yIHRoZSBzdG9yZSB0byB1c2UgaW5zdGVhZC5cbiAgICogQHJldHVybnMge3ZvaWR9XG4gICAqL1xuICBmdW5jdGlvbiByZXBsYWNlUmVkdWNlcihuZXh0UmVkdWNlcikge1xuICAgIGlmICh0eXBlb2YgbmV4dFJlZHVjZXIgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignRXhwZWN0ZWQgdGhlIG5leHRSZWR1Y2VyIHRvIGJlIGEgZnVuY3Rpb24uJyk7XG4gICAgfVxuXG4gICAgY3VycmVudFJlZHVjZXIgPSBuZXh0UmVkdWNlcjtcbiAgICBkaXNwYXRjaCh7IHR5cGU6IEFjdGlvblR5cGVzLklOSVQgfSk7XG4gIH1cblxuICAvKipcbiAgICogSW50ZXJvcGVyYWJpbGl0eSBwb2ludCBmb3Igb2JzZXJ2YWJsZS9yZWFjdGl2ZSBsaWJyYXJpZXMuXG4gICAqIEByZXR1cm5zIHtvYnNlcnZhYmxlfSBBIG1pbmltYWwgb2JzZXJ2YWJsZSBvZiBzdGF0ZSBjaGFuZ2VzLlxuICAgKiBGb3IgbW9yZSBpbmZvcm1hdGlvbiwgc2VlIHRoZSBvYnNlcnZhYmxlIHByb3Bvc2FsOlxuICAgKiBodHRwczovL2dpdGh1Yi5jb20vemVucGFyc2luZy9lcy1vYnNlcnZhYmxlXG4gICAqL1xuICBmdW5jdGlvbiBvYnNlcnZhYmxlKCkge1xuICAgIHZhciBfcmVmO1xuXG4gICAgdmFyIG91dGVyU3Vic2NyaWJlID0gc3Vic2NyaWJlO1xuICAgIHJldHVybiBfcmVmID0ge1xuICAgICAgLyoqXG4gICAgICAgKiBUaGUgbWluaW1hbCBvYnNlcnZhYmxlIHN1YnNjcmlwdGlvbiBtZXRob2QuXG4gICAgICAgKiBAcGFyYW0ge09iamVjdH0gb2JzZXJ2ZXIgQW55IG9iamVjdCB0aGF0IGNhbiBiZSB1c2VkIGFzIGFuIG9ic2VydmVyLlxuICAgICAgICogVGhlIG9ic2VydmVyIG9iamVjdCBzaG91bGQgaGF2ZSBhIGBuZXh0YCBtZXRob2QuXG4gICAgICAgKiBAcmV0dXJucyB7c3Vic2NyaXB0aW9ufSBBbiBvYmplY3Qgd2l0aCBhbiBgdW5zdWJzY3JpYmVgIG1ldGhvZCB0aGF0IGNhblxuICAgICAgICogYmUgdXNlZCB0byB1bnN1YnNjcmliZSB0aGUgb2JzZXJ2YWJsZSBmcm9tIHRoZSBzdG9yZSwgYW5kIHByZXZlbnQgZnVydGhlclxuICAgICAgICogZW1pc3Npb24gb2YgdmFsdWVzIGZyb20gdGhlIG9ic2VydmFibGUuXG4gICAgICAgKi9cblxuICAgICAgc3Vic2NyaWJlOiBmdW5jdGlvbiBzdWJzY3JpYmUob2JzZXJ2ZXIpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvYnNlcnZlciAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCB0aGUgb2JzZXJ2ZXIgdG8gYmUgYW4gb2JqZWN0LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gb2JzZXJ2ZVN0YXRlKCkge1xuICAgICAgICAgIGlmIChvYnNlcnZlci5uZXh0KSB7XG4gICAgICAgICAgICBvYnNlcnZlci5uZXh0KGdldFN0YXRlKCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIG9ic2VydmVTdGF0ZSgpO1xuICAgICAgICB2YXIgdW5zdWJzY3JpYmUgPSBvdXRlclN1YnNjcmliZShvYnNlcnZlU3RhdGUpO1xuICAgICAgICByZXR1cm4geyB1bnN1YnNjcmliZTogdW5zdWJzY3JpYmUgfTtcbiAgICAgIH1cbiAgICB9LCBfcmVmW19zeW1ib2xPYnNlcnZhYmxlMltcImRlZmF1bHRcIl1dID0gZnVuY3Rpb24gKCkge1xuICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfSwgX3JlZjtcbiAgfVxuXG4gIC8vIFdoZW4gYSBzdG9yZSBpcyBjcmVhdGVkLCBhbiBcIklOSVRcIiBhY3Rpb24gaXMgZGlzcGF0Y2hlZCBzbyB0aGF0IGV2ZXJ5XG4gIC8vIHJlZHVjZXIgcmV0dXJucyB0aGVpciBpbml0aWFsIHN0YXRlLiBUaGlzIGVmZmVjdGl2ZWx5IHBvcHVsYXRlc1xuICAvLyB0aGUgaW5pdGlhbCBzdGF0ZSB0cmVlLlxuICBkaXNwYXRjaCh7IHR5cGU6IEFjdGlvblR5cGVzLklOSVQgfSk7XG5cbiAgcmV0dXJuIF9yZWYyID0ge1xuICAgIGRpc3BhdGNoOiBkaXNwYXRjaCxcbiAgICBzdWJzY3JpYmU6IHN1YnNjcmliZSxcbiAgICBnZXRTdGF0ZTogZ2V0U3RhdGUsXG4gICAgcmVwbGFjZVJlZHVjZXI6IHJlcGxhY2VSZWR1Y2VyXG4gIH0sIF9yZWYyW19zeW1ib2xPYnNlcnZhYmxlMltcImRlZmF1bHRcIl1dID0gb2JzZXJ2YWJsZSwgX3JlZjI7XG59IiwiLyogZ2xvYmFsIHdpbmRvdyAqL1xuJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vcG9ueWZpbGwnKShnbG9iYWwgfHwgd2luZG93IHx8IHRoaXMpO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIHN5bWJvbE9ic2VydmFibGVQb255ZmlsbChyb290KSB7XG5cdHZhciByZXN1bHQ7XG5cdHZhciBTeW1ib2wgPSByb290LlN5bWJvbDtcblxuXHRpZiAodHlwZW9mIFN5bWJvbCA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdGlmIChTeW1ib2wub2JzZXJ2YWJsZSkge1xuXHRcdFx0cmVzdWx0ID0gU3ltYm9sLm9ic2VydmFibGU7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGlmICh0eXBlb2YgU3ltYm9sLmZvciA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRyZXN1bHQgPSBTeW1ib2wuZm9yKCdvYnNlcnZhYmxlJyk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRyZXN1bHQgPSBTeW1ib2woJ29ic2VydmFibGUnKTtcblx0XHRcdH1cblx0XHRcdFN5bWJvbC5vYnNlcnZhYmxlID0gcmVzdWx0O1xuXHRcdH1cblx0fSBlbHNlIHtcblx0XHRyZXN1bHQgPSAnQEBvYnNlcnZhYmxlJztcblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59O1xuIiwiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcblxuaW1wb3J0IFNlbGVjdCBmcm9tICcuL1NlbGVjdCc7XG5pbXBvcnQgc3RyaXBEaWFjcml0aWNzIGZyb20gJy4vdXRpbHMvc3RyaXBEaWFjcml0aWNzJztcblxubGV0IHJlcXVlc3RJZCA9IDA7XG5cbmZ1bmN0aW9uIGluaXRDYWNoZSAoY2FjaGUpIHtcblx0aWYgKGNhY2hlICYmIHR5cGVvZiBjYWNoZSAhPT0gJ29iamVjdCcpIHtcblx0XHRjYWNoZSA9IHt9O1xuXHR9XG5cdHJldHVybiBjYWNoZSA/IGNhY2hlIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQ2FjaGUgKGNhY2hlLCBpbnB1dCwgZGF0YSkge1xuXHRpZiAoIWNhY2hlKSByZXR1cm47XG5cdGNhY2hlW2lucHV0XSA9IGRhdGE7XG59XG5cbmZ1bmN0aW9uIGdldEZyb21DYWNoZSAoY2FjaGUsIGlucHV0KSB7XG5cdGlmICghY2FjaGUpIHJldHVybjtcblx0Zm9yIChsZXQgaSA9IGlucHV0Lmxlbmd0aDsgaSA+PSAwOyAtLWkpIHtcblx0XHRsZXQgY2FjaGVLZXkgPSBpbnB1dC5zbGljZSgwLCBpKTtcblx0XHRpZiAoY2FjaGVbY2FjaGVLZXldICYmIChpbnB1dCA9PT0gY2FjaGVLZXkgfHwgY2FjaGVbY2FjaGVLZXldLmNvbXBsZXRlKSkge1xuXHRcdFx0cmV0dXJuIGNhY2hlW2NhY2hlS2V5XTtcblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gdGhlblByb21pc2UgKHByb21pc2UsIGNhbGxiYWNrKSB7XG5cdGlmICghcHJvbWlzZSB8fCB0eXBlb2YgcHJvbWlzZS50aGVuICE9PSAnZnVuY3Rpb24nKSByZXR1cm47XG5cdHJldHVybiBwcm9taXNlLnRoZW4oKGRhdGEpID0+IHtcblx0XHRjYWxsYmFjayhudWxsLCBkYXRhKTtcblx0fSwgKGVycikgPT4ge1xuXHRcdGNhbGxiYWNrKGVycik7XG5cdH0pO1xufVxuXG5jb25zdCBzdHJpbmdPck5vZGUgPSBSZWFjdC5Qcm9wVHlwZXMub25lT2ZUeXBlKFtcblx0UmVhY3QuUHJvcFR5cGVzLnN0cmluZyxcblx0UmVhY3QuUHJvcFR5cGVzLm5vZGVcbl0pO1xuXG5jb25zdCBBc3luYyA9IFJlYWN0LmNyZWF0ZUNsYXNzKHtcblx0cHJvcFR5cGVzOiB7XG5cdFx0Y2FjaGU6IFJlYWN0LlByb3BUeXBlcy5hbnksICAgICAgICAgICAgICAgICAgICAgLy8gb2JqZWN0IHRvIHVzZSB0byBjYWNoZSByZXN1bHRzLCBjYW4gYmUgbnVsbCB0byBkaXNhYmxlIGNhY2hlXG5cdFx0aWdub3JlQWNjZW50czogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgLy8gd2hldGhlciB0byBzdHJpcCBkaWFjcml0aWNzIHdoZW4gZmlsdGVyaW5nIChzaGFyZWQgd2l0aCBTZWxlY3QpXG5cdFx0aWdub3JlQ2FzZTogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgICAgLy8gd2hldGhlciB0byBwZXJmb3JtIGNhc2UtaW5zZW5zaXRpdmUgZmlsdGVyaW5nIChzaGFyZWQgd2l0aCBTZWxlY3QpXG5cdFx0aXNMb2FkaW5nOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgICAgLy8gb3ZlcnJpZGVzIHRoZSBpc0xvYWRpbmcgc3RhdGUgd2hlbiBzZXQgdG8gdHJ1ZVxuXHRcdGxvYWRPcHRpb25zOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYy5pc1JlcXVpcmVkLCAgIC8vIGZ1bmN0aW9uIHRvIGNhbGwgdG8gbG9hZCBvcHRpb25zIGFzeW5jaHJvbm91c2x5XG5cdFx0bG9hZGluZ1BsYWNlaG9sZGVyOiBSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLCAgICAgLy8gcmVwbGFjZXMgdGhlIHBsYWNlaG9sZGVyIHdoaWxlIG9wdGlvbnMgYXJlIGxvYWRpbmdcblx0XHRtaW5pbXVtSW5wdXQ6IFJlYWN0LlByb3BUeXBlcy5udW1iZXIsICAgICAgICAgICAvLyB0aGUgbWluaW11bSBudW1iZXIgb2YgY2hhcmFjdGVycyB0aGF0IHRyaWdnZXIgbG9hZE9wdGlvbnNcblx0XHRub1Jlc3VsdHNUZXh0OiBzdHJpbmdPck5vZGUsICAgICAgICAgICAgICAgICAgICAvLyBwbGFjZWhvbGRlciBkaXNwbGF5ZWQgd2hlbiB0aGVyZSBhcmUgbm8gbWF0Y2hpbmcgc2VhcmNoIHJlc3VsdHMgKHNoYXJlZCB3aXRoIFNlbGVjdClcblx0XHRwbGFjZWhvbGRlcjogc3RyaW5nT3JOb2RlLCAgICAgICAgICAgICAgICAgICAgICAvLyBmaWVsZCBwbGFjZWhvbGRlciwgZGlzcGxheWVkIHdoZW4gdGhlcmUncyBubyB2YWx1ZSAoc2hhcmVkIHdpdGggU2VsZWN0KVxuXHRcdHNlYXJjaFByb21wdFRleHQ6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgICAgIC8vIGxhYmVsIHRvIHByb21wdCBmb3Igc2VhcmNoIGlucHV0XG5cdFx0c2VhcmNoaW5nVGV4dDogUmVhY3QuUHJvcFR5cGVzLnN0cmluZywgICAgICAgICAgLy8gbWVzc2FnZSB0byBkaXNwbGF5IHdoaWxlIG9wdGlvbnMgYXJlIGxvYWRpbmdcblx0fSxcblx0Z2V0RGVmYXVsdFByb3BzICgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Y2FjaGU6IHRydWUsXG5cdFx0XHRpZ25vcmVBY2NlbnRzOiB0cnVlLFxuXHRcdFx0aWdub3JlQ2FzZTogdHJ1ZSxcblx0XHRcdGxvYWRpbmdQbGFjZWhvbGRlcjogJ0xvYWRpbmcuLi4nLFxuXHRcdFx0bWluaW11bUlucHV0OiAwLFxuXHRcdFx0c2VhcmNoaW5nVGV4dDogJ1NlYXJjaGluZy4uLicsXG5cdFx0XHRzZWFyY2hQcm9tcHRUZXh0OiAnVHlwZSB0byBzZWFyY2gnLFxuXHRcdH07XG5cdH0sXG5cdGdldEluaXRpYWxTdGF0ZSAoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGNhY2hlOiBpbml0Q2FjaGUodGhpcy5wcm9wcy5jYWNoZSksXG5cdFx0XHRpc0xvYWRpbmc6IGZhbHNlLFxuXHRcdFx0b3B0aW9uczogW10sXG5cdFx0fTtcblx0fSxcblx0Y29tcG9uZW50V2lsbE1vdW50ICgpIHtcblx0XHR0aGlzLl9sYXN0SW5wdXQgPSAnJztcblx0fSxcblx0Y29tcG9uZW50RGlkTW91bnQgKCkge1xuXHRcdHRoaXMubG9hZE9wdGlvbnMoJycpO1xuXHR9LFxuXHRjb21wb25lbnRXaWxsUmVjZWl2ZVByb3BzIChuZXh0UHJvcHMpIHtcblx0XHRpZiAobmV4dFByb3BzLmNhY2hlICE9PSB0aGlzLnByb3BzLmNhY2hlKSB7XG5cdFx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdFx0Y2FjaGU6IGluaXRDYWNoZShuZXh0UHJvcHMuY2FjaGUpLFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9LFxuXHRmb2N1cyAoKSB7XG5cdFx0dGhpcy5yZWZzLnNlbGVjdC5mb2N1cygpO1xuXHR9LFxuXHRyZXNldFN0YXRlICgpIHtcblx0XHR0aGlzLl9jdXJyZW50UmVxdWVzdElkID0gLTE7XG5cdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRpc0xvYWRpbmc6IGZhbHNlLFxuXHRcdFx0b3B0aW9uczogW10sXG5cdFx0fSk7XG5cdH0sXG5cdGdldFJlc3BvbnNlSGFuZGxlciAoaW5wdXQpIHtcblx0XHRsZXQgX3JlcXVlc3RJZCA9IHRoaXMuX2N1cnJlbnRSZXF1ZXN0SWQgPSByZXF1ZXN0SWQrKztcblx0XHRyZXR1cm4gKGVyciwgZGF0YSkgPT4ge1xuXHRcdFx0aWYgKGVycikgdGhyb3cgZXJyO1xuXHRcdFx0aWYgKCF0aGlzLmlzTW91bnRlZCgpKSByZXR1cm47XG5cdFx0XHR1cGRhdGVDYWNoZSh0aGlzLnN0YXRlLmNhY2hlLCBpbnB1dCwgZGF0YSk7XG5cdFx0XHRpZiAoX3JlcXVlc3RJZCAhPT0gdGhpcy5fY3VycmVudFJlcXVlc3RJZCkgcmV0dXJuO1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRcdGlzTG9hZGluZzogZmFsc2UsXG5cdFx0XHRcdG9wdGlvbnM6IGRhdGEgJiYgZGF0YS5vcHRpb25zIHx8IFtdLFxuXHRcdFx0fSk7XG5cdFx0fTtcblx0fSxcblx0bG9hZE9wdGlvbnMgKGlucHV0KSB7XG5cdFx0aWYgKHRoaXMucHJvcHMuaWdub3JlQWNjZW50cykgaW5wdXQgPSBzdHJpcERpYWNyaXRpY3MoaW5wdXQpO1xuXHRcdGlmICh0aGlzLnByb3BzLmlnbm9yZUNhc2UpIGlucHV0ID0gaW5wdXQudG9Mb3dlckNhc2UoKTtcblx0XHR0aGlzLl9sYXN0SW5wdXQgPSBpbnB1dDtcblx0XHRpZiAoaW5wdXQubGVuZ3RoIDwgdGhpcy5wcm9wcy5taW5pbXVtSW5wdXQpIHtcblx0XHRcdHJldHVybiB0aGlzLnJlc2V0U3RhdGUoKTtcblx0XHR9XG5cdFx0bGV0IGNhY2hlUmVzdWx0ID0gZ2V0RnJvbUNhY2hlKHRoaXMuc3RhdGUuY2FjaGUsIGlucHV0KTtcblx0XHRpZiAoY2FjaGVSZXN1bHQpIHtcblx0XHRcdHJldHVybiB0aGlzLnNldFN0YXRlKHtcblx0XHRcdFx0b3B0aW9uczogY2FjaGVSZXN1bHQub3B0aW9ucyxcblx0XHRcdH0pO1xuXHRcdH1cblx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdGlzTG9hZGluZzogdHJ1ZSxcblx0XHR9KTtcblx0XHRsZXQgcmVzcG9uc2VIYW5kbGVyID0gdGhpcy5nZXRSZXNwb25zZUhhbmRsZXIoaW5wdXQpO1xuXHRcdHJldHVybiB0aGVuUHJvbWlzZSh0aGlzLnByb3BzLmxvYWRPcHRpb25zKGlucHV0LCByZXNwb25zZUhhbmRsZXIpLCByZXNwb25zZUhhbmRsZXIpO1xuXHR9LFxuXHRyZW5kZXIgKCkge1xuXHRcdGxldCB7IG5vUmVzdWx0c1RleHQgfSA9IHRoaXMucHJvcHM7XG5cdFx0bGV0IHsgaXNMb2FkaW5nLCBvcHRpb25zIH0gPSB0aGlzLnN0YXRlO1xuXHRcdGlmICh0aGlzLnByb3BzLmlzTG9hZGluZykgaXNMb2FkaW5nID0gdHJ1ZTtcblx0XHRsZXQgcGxhY2Vob2xkZXIgPSBpc0xvYWRpbmcgPyB0aGlzLnByb3BzLmxvYWRpbmdQbGFjZWhvbGRlciA6IHRoaXMucHJvcHMucGxhY2Vob2xkZXI7XG5cdFx0aWYgKCFvcHRpb25zLmxlbmd0aCkge1xuXHRcdFx0aWYgKHRoaXMuX2xhc3RJbnB1dC5sZW5ndGggPCB0aGlzLnByb3BzLm1pbmltdW1JbnB1dCkgbm9SZXN1bHRzVGV4dCA9IHRoaXMucHJvcHMuc2VhcmNoUHJvbXB0VGV4dDtcblx0XHRcdGlmIChpc0xvYWRpbmcpIG5vUmVzdWx0c1RleHQgPSB0aGlzLnByb3BzLnNlYXJjaGluZ1RleHQ7XG5cdFx0fVxuXHRcdHJldHVybiAoXG5cdFx0XHQ8U2VsZWN0XG5cdFx0XHRcdHsuLi50aGlzLnByb3BzfVxuXHRcdFx0XHRyZWY9XCJzZWxlY3RcIlxuXHRcdFx0XHRpc0xvYWRpbmc9e2lzTG9hZGluZ31cblx0XHRcdFx0bm9SZXN1bHRzVGV4dD17bm9SZXN1bHRzVGV4dH1cblx0XHRcdFx0b25JbnB1dENoYW5nZT17dGhpcy5sb2FkT3B0aW9uc31cblx0XHRcdFx0b3B0aW9ucz17b3B0aW9uc31cblx0XHRcdFx0cGxhY2Vob2xkZXI9e3BsYWNlaG9sZGVyfVxuXHRcdFx0XHQvPlxuXHRcdCk7XG5cdH1cbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IEFzeW5jO1xuIiwiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCBjbGFzc05hbWVzIGZyb20gJ2NsYXNzbmFtZXMnO1xuaW1wb3J0IHtEcmFnU291cmNlLCBEcm9wVGFyZ2V0fSBmcm9tICdyZWFjdC1kbmQnO1xuXG5jb25zdCBpdGVtU291cmNlID0ge1xuICBiZWdpbkRyYWcocHJvcHMpIHtcbiAgICByZXR1cm4ge3ZhbHVlOiBwcm9wcy52YWx1ZX07XG4gIH1cbn07XG5cbmNvbnN0IGl0ZW1UYXJnZXQgPSB7XG4gIGhvdmVyKHByb3BzLCBtb25pdG9yKSB7XG4gICAgY29uc3QgaXRlbSA9IG1vbml0b3IuZ2V0SXRlbSgpLnZhbHVlO1xuICAgIGlmIChpdGVtICE9PSBwcm9wcy52YWx1ZSkge1xuICAgICAgcHJvcHMubW92ZUl0ZW0oaXRlbSwgcHJvcHMudmFsdWUpO1xuICAgIH1cbiAgfVxufTtcblxuZnVuY3Rpb24gY29sbGVjdERyYWcoY29ubmVjdCwgbW9uaXRvcikge1xuICByZXR1cm4ge1xuICAgIGNvbm5lY3REcmFnU291cmNlOiBjb25uZWN0LmRyYWdTb3VyY2UoKSxcbiAgICBkcmFnZ2luZ09wYWNpdHk6IG1vbml0b3IuaXNEcmFnZ2luZygpID8gMC4zIDogbnVsbFxuICB9O1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0RHJvcChjb25uZWN0KSB7XG4gIHJldHVybiB7XG4gICAgY29ubmVjdERyb3BUYXJnZXQ6IGNvbm5lY3QuZHJvcFRhcmdldCgpXG4gIH07XG59XG5cbnZhciBEcmFnZ2FibGVWYWx1ZSA9IGZ1bmN0aW9uKENvbXBvbmVudCkge1xuICByZXR1cm4gKFxuICAgIERyYWdTb3VyY2UoXCJEcmFnZ2FibGVTZWxlY3RcIiwgaXRlbVNvdXJjZSwgY29sbGVjdERyYWcpKFxuICAgIERyb3BUYXJnZXQoXCJEcmFnZ2FibGVTZWxlY3RcIiwgaXRlbVRhcmdldCwgY29sbGVjdERyb3ApKFxuICAgICAgUmVhY3QuY3JlYXRlQ2xhc3Moe1xuICAgICAgICByZW5kZXIoKSB7XG4gICAgICAgICAgY29uc3Qge2Nvbm5lY3REcmFnU291cmNlLCBjb25uZWN0RHJvcFRhcmdldCwgZHJhZ2dpbmdPcGFjaXR5LCAuLi5yZXN0fSA9IHRoaXMucHJvcHM7XG4gICAgICAgICAgcmV0dXJuIGNvbm5lY3REcmFnU291cmNlKGNvbm5lY3REcm9wVGFyZ2V0KFxuICAgICAgICAgICAgPHNwYW4gc3R5bGU9e3tvcGFjaXR5OiBkcmFnZ2luZ09wYWNpdHl9fVxuICAgICAgICAgICAgICAgICAgb25Nb3VzZURvd249e2UgPT4gZS5zdG9wUHJvcGFnYXRpb24oKX0+XG4gICAgICAgICAgICAgICAgICAgIDxDb21wb25lbnQgey4uLnJlc3R9IC8+XG4gICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgKSk7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgKSlcbiAgKTtcbn07XG5cbnZhciBEcmFnZ2FibGVTZWxlY3QgPSBmdW5jdGlvbihDb21wb25lbnQsIFZhbHVlQ29tcG9uZW50KSB7XG4gIHJldHVybiBSZWFjdC5jcmVhdGVDbGFzcyh7XG4gICAgbW92ZUl0ZW0oc3JjLCBkZXN0KSB7XG4gICAgICBjb25zdCB7b25DaGFuZ2UsIHZhbHVlfSA9IHRoaXMucHJvcHMsXG4gICAgICAgICAgICB2YWx1ZXMgPSB2YWx1ZS5tYXAoZCA9PiBkLnZhbHVlKSxcbiAgICAgICAgICAgIHNyY0luZGV4ID0gdmFsdWVzLmluZGV4T2Yoc3JjLnZhbHVlKSxcbiAgICAgICAgICAgIGRlc3RJbmRleCA9IHZhbHVlcy5pbmRleE9mKGRlc3QudmFsdWUpLFxuICAgICAgICAgICAgdmFsdWVDb3B5ID0gdmFsdWUuY29uY2F0KFtdKTtcblxuICAgICAgdmFsdWVDb3B5LnNwbGljZShzcmNJbmRleCwgMSk7XG4gICAgICB2YWx1ZUNvcHkuc3BsaWNlKGRlc3RJbmRleCwgMCwgc3JjKTtcblxuICAgICAgb25DaGFuZ2UodmFsdWVDb3B5KTtcbiAgICB9LFxuXG4gIFx0cmVuZGVyKCkge1xuICBcdFx0cmV0dXJuIChcbiAgXHRcdFx0PENvbXBvbmVudCB7Li4udGhpcy5wcm9wc31cbiAgXHRcdFx0XHRtdWx0aT17dHJ1ZX1cbiAgICAgICAgICBtb3ZlSXRlbT17dGhpcy5tb3ZlSXRlbX1cbiAgICAgICAgICB2YWx1ZUNvbXBvbmVudD17VmFsdWVDb21wb25lbnR9IC8+XG4gIFx0XHQpO1xuICBcdH1cbiAgfSk7XG59O1xuXG5leHBvcnQge0RyYWdnYWJsZVNlbGVjdCwgRHJhZ2dhYmxlVmFsdWV9O1xuIiwiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCBjbGFzc05hbWVzIGZyb20gJ2NsYXNzbmFtZXMnO1xuXG5jb25zdCBPcHRpb24gPSBSZWFjdC5jcmVhdGVDbGFzcyh7XG5cdHByb3BUeXBlczoge1xuXHRcdGNoaWxkcmVuOiBSZWFjdC5Qcm9wVHlwZXMubm9kZSxcblx0XHRjbGFzc05hbWU6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgICAgICAgICAgIC8vIGNsYXNzTmFtZSAoYmFzZWQgb24gbW91c2UgcG9zaXRpb24pXG5cdFx0aXNEaXNhYmxlZDogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgICAvLyB0aGUgb3B0aW9uIGlzIGRpc2FibGVkXG5cdFx0aXNGb2N1c2VkOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgICAvLyB0aGUgb3B0aW9uIGlzIGZvY3VzZWRcblx0XHRpc1NlbGVjdGVkOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgIC8vIHRoZSBvcHRpb24gaXMgc2VsZWN0ZWRcblx0XHRvbkZvY3VzOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgICAgIC8vIG1ldGhvZCB0byBoYW5kbGUgbW91c2VFbnRlciBvbiBvcHRpb24gZWxlbWVudFxuXHRcdG9uU2VsZWN0OiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgICAgLy8gbWV0aG9kIHRvIGhhbmRsZSBjbGljayBvbiBvcHRpb24gZWxlbWVudFxuXHRcdG9uVW5mb2N1czogUmVhY3QuUHJvcFR5cGVzLmZ1bmMsICAgICAgICAgICAgICAgLy8gbWV0aG9kIHRvIGhhbmRsZSBtb3VzZUxlYXZlIG9uIG9wdGlvbiBlbGVtZW50XG5cdFx0b3B0aW9uOiBSZWFjdC5Qcm9wVHlwZXMub2JqZWN0LmlzUmVxdWlyZWQsICAgICAvLyBvYmplY3QgdGhhdCBpcyBiYXNlIGZvciB0aGF0IG9wdGlvblxuXHR9LFxuXHRibG9ja0V2ZW50IChldmVudCkge1xuXHRcdGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG5cdFx0ZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG5cdFx0aWYgKChldmVudC50YXJnZXQudGFnTmFtZSAhPT0gJ0EnKSB8fCAhKCdocmVmJyBpbiBldmVudC50YXJnZXQpKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChldmVudC50YXJnZXQudGFyZ2V0KSB7XG5cdFx0XHR3aW5kb3cub3BlbihldmVudC50YXJnZXQuaHJlZiwgZXZlbnQudGFyZ2V0LnRhcmdldCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHdpbmRvdy5sb2NhdGlvbi5ocmVmID0gZXZlbnQudGFyZ2V0LmhyZWY7XG5cdFx0fVxuXHR9LFxuXG5cdGhhbmRsZU1vdXNlRG93biAoZXZlbnQpIHtcblx0XHRldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuXHRcdGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuXHRcdHRoaXMucHJvcHMub25TZWxlY3QodGhpcy5wcm9wcy5vcHRpb24sIGV2ZW50KTtcblx0fSxcblxuXHRoYW5kbGVNb3VzZUVudGVyIChldmVudCkge1xuXHRcdHRoaXMub25Gb2N1cyhldmVudCk7XG5cdH0sXG5cblx0aGFuZGxlTW91c2VNb3ZlIChldmVudCkge1xuXHRcdHRoaXMub25Gb2N1cyhldmVudCk7XG5cdH0sXG5cblx0aGFuZGxlVG91Y2hFbmQoZXZlbnQpe1xuXHRcdC8vIENoZWNrIGlmIHRoZSB2aWV3IGlzIGJlaW5nIGRyYWdnZWQsIEluIHRoaXMgY2FzZVxuXHRcdC8vIHdlIGRvbid0IHdhbnQgdG8gZmlyZSB0aGUgY2xpY2sgZXZlbnQgKGJlY2F1c2UgdGhlIHVzZXIgb25seSB3YW50cyB0byBzY3JvbGwpXG5cdFx0aWYodGhpcy5kcmFnZ2luZykgcmV0dXJuO1xuXG5cdFx0dGhpcy5oYW5kbGVNb3VzZURvd24oZXZlbnQpO1xuXHR9LFxuXG5cdGhhbmRsZVRvdWNoTW92ZSAoZXZlbnQpIHtcblx0XHQvLyBTZXQgYSBmbGFnIHRoYXQgdGhlIHZpZXcgaXMgYmVpbmcgZHJhZ2dlZFxuXHRcdHRoaXMuZHJhZ2dpbmcgPSB0cnVlO1xuXHR9LFxuXG5cdGhhbmRsZVRvdWNoU3RhcnQgKGV2ZW50KSB7XG5cdFx0Ly8gU2V0IGEgZmxhZyB0aGF0IHRoZSB2aWV3IGlzIG5vdCBiZWluZyBkcmFnZ2VkXG5cdFx0dGhpcy5kcmFnZ2luZyA9IGZhbHNlO1xuXHR9LFxuXG5cdG9uRm9jdXMgKGV2ZW50KSB7XG5cdFx0aWYgKCF0aGlzLnByb3BzLmlzRm9jdXNlZCkge1xuXHRcdFx0dGhpcy5wcm9wcy5vbkZvY3VzKHRoaXMucHJvcHMub3B0aW9uLCBldmVudCk7XG5cdFx0fVxuXHR9LFxuXHRyZW5kZXIgKCkge1xuXHRcdHZhciB7IG9wdGlvbiB9ID0gdGhpcy5wcm9wcztcblx0XHR2YXIgY2xhc3NOYW1lID0gY2xhc3NOYW1lcyh0aGlzLnByb3BzLmNsYXNzTmFtZSwgb3B0aW9uLmNsYXNzTmFtZSk7XG5cblx0XHRyZXR1cm4gb3B0aW9uLmRpc2FibGVkID8gKFxuXHRcdFx0PGRpdiBjbGFzc05hbWU9e2NsYXNzTmFtZX1cblx0XHRcdFx0b25Nb3VzZURvd249e3RoaXMuYmxvY2tFdmVudH1cblx0XHRcdFx0b25DbGljaz17dGhpcy5ibG9ja0V2ZW50fT5cblx0XHRcdFx0e3RoaXMucHJvcHMuY2hpbGRyZW59XG5cdFx0XHQ8L2Rpdj5cblx0XHQpIDogKFxuXHRcdFx0PGRpdiBjbGFzc05hbWU9e2NsYXNzTmFtZX1cblx0XHRcdFx0c3R5bGU9e29wdGlvbi5zdHlsZX1cblx0XHRcdFx0b25Nb3VzZURvd249e3RoaXMuaGFuZGxlTW91c2VEb3dufVxuXHRcdFx0XHRvbk1vdXNlRW50ZXI9e3RoaXMuaGFuZGxlTW91c2VFbnRlcn1cblx0XHRcdFx0b25Nb3VzZU1vdmU9e3RoaXMuaGFuZGxlTW91c2VNb3ZlfVxuXHRcdFx0XHRvblRvdWNoU3RhcnQ9e3RoaXMuaGFuZGxlVG91Y2hTdGFydH1cblx0XHRcdFx0b25Ub3VjaE1vdmU9e3RoaXMuaGFuZGxlVG91Y2hNb3ZlfVxuXHRcdFx0XHRvblRvdWNoRW5kPXt0aGlzLmhhbmRsZVRvdWNoRW5kfVxuXHRcdFx0XHR0aXRsZT17b3B0aW9uLnRpdGxlfT5cblx0XHRcdFx0e3RoaXMucHJvcHMuY2hpbGRyZW59XG5cdFx0XHQ8L2Rpdj5cblx0XHQpO1xuXHR9XG59KTtcblxubW9kdWxlLmV4cG9ydHMgPSBPcHRpb247XG4iLCJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnO1xuaW1wb3J0IGNsYXNzTmFtZXMgZnJvbSAnY2xhc3NuYW1lcyc7XG5cbmNvbnN0IFZhbHVlID0gUmVhY3QuY3JlYXRlQ2xhc3Moe1xuXG5cdGRpc3BsYXlOYW1lOiAnVmFsdWUnLFxuXG5cdHByb3BUeXBlczoge1xuXHRcdGNoaWxkcmVuOiBSZWFjdC5Qcm9wVHlwZXMubm9kZSxcblx0XHRkaXNhYmxlZDogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgICAgLy8gZGlzYWJsZWQgcHJvcCBwYXNzZWQgdG8gUmVhY3RTZWxlY3Rcblx0XHRvbkNsaWNrOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgICAgLy8gbWV0aG9kIHRvIGhhbmRsZSBjbGljayBvbiB2YWx1ZSBsYWJlbFxuXHRcdG9uUmVtb3ZlOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgICAvLyBtZXRob2QgdG8gaGFuZGxlIHJlbW92YWwgb2YgdGhlIHZhbHVlXG5cdFx0dmFsdWU6IFJlYWN0LlByb3BUeXBlcy5vYmplY3QuaXNSZXF1aXJlZCwgICAgIC8vIHRoZSBvcHRpb24gb2JqZWN0IGZvciB0aGlzIHZhbHVlXG5cdH0sXG5cblx0aGFuZGxlTW91c2VEb3duIChldmVudCkge1xuXHRcdGlmIChldmVudC50eXBlID09PSAnbW91c2Vkb3duJyAmJiBldmVudC5idXR0b24gIT09IDApIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKHRoaXMucHJvcHMub25DbGljaykge1xuXHRcdFx0ZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG5cdFx0XHR0aGlzLnByb3BzLm9uQ2xpY2sodGhpcy5wcm9wcy52YWx1ZSwgZXZlbnQpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAodGhpcy5wcm9wcy52YWx1ZS5ocmVmKSB7XG5cdFx0XHRldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcblx0XHR9XG5cdH0sXG5cblx0b25SZW1vdmUgKGV2ZW50KSB7XG5cdFx0ZXZlbnQucHJldmVudERlZmF1bHQoKTtcblx0XHRldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcblx0XHR0aGlzLnByb3BzLm9uUmVtb3ZlKHRoaXMucHJvcHMudmFsdWUpO1xuXHR9LFxuXG5cdGhhbmRsZVRvdWNoRW5kUmVtb3ZlIChldmVudCl7XG5cdFx0Ly8gQ2hlY2sgaWYgdGhlIHZpZXcgaXMgYmVpbmcgZHJhZ2dlZCwgSW4gdGhpcyBjYXNlXG5cdFx0Ly8gd2UgZG9uJ3Qgd2FudCB0byBmaXJlIHRoZSBjbGljayBldmVudCAoYmVjYXVzZSB0aGUgdXNlciBvbmx5IHdhbnRzIHRvIHNjcm9sbClcblx0XHRpZih0aGlzLmRyYWdnaW5nKSByZXR1cm47XG5cblx0XHQvLyBGaXJlIHRoZSBtb3VzZSBldmVudHNcblx0XHR0aGlzLm9uUmVtb3ZlKGV2ZW50KTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaE1vdmUgKGV2ZW50KSB7XG5cdFx0Ly8gU2V0IGEgZmxhZyB0aGF0IHRoZSB2aWV3IGlzIGJlaW5nIGRyYWdnZWRcblx0XHR0aGlzLmRyYWdnaW5nID0gdHJ1ZTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaFN0YXJ0IChldmVudCkge1xuXHRcdC8vIFNldCBhIGZsYWcgdGhhdCB0aGUgdmlldyBpcyBub3QgYmVpbmcgZHJhZ2dlZFxuXHRcdHRoaXMuZHJhZ2dpbmcgPSBmYWxzZTtcblx0fSxcblxuXHRyZW5kZXJSZW1vdmVJY29uICgpIHtcblx0XHRpZiAodGhpcy5wcm9wcy5kaXNhYmxlZCB8fCAhdGhpcy5wcm9wcy5vblJlbW92ZSkgcmV0dXJuO1xuXHRcdHJldHVybiAoXG5cdFx0XHQ8c3BhbiBjbGFzc05hbWU9XCJTZWxlY3QtdmFsdWUtaWNvblwiXG5cdFx0XHRcdG9uTW91c2VEb3duPXt0aGlzLm9uUmVtb3ZlfVxuXHRcdFx0XHRvblRvdWNoRW5kPXt0aGlzLmhhbmRsZVRvdWNoRW5kUmVtb3ZlfVxuXHRcdFx0XHRvblRvdWNoU3RhcnQ9e3RoaXMuaGFuZGxlVG91Y2hTdGFydH1cblx0XHRcdFx0b25Ub3VjaE1vdmU9e3RoaXMuaGFuZGxlVG91Y2hNb3ZlfT5cblx0XHRcdFx0JnRpbWVzO1xuXHRcdFx0PC9zcGFuPlxuXHRcdCk7XG5cdH0sXG5cblx0cmVuZGVyTGFiZWwgKCkge1xuXHRcdGxldCBjbGFzc05hbWUgPSAnU2VsZWN0LXZhbHVlLWxhYmVsJztcblx0XHRyZXR1cm4gdGhpcy5wcm9wcy5vbkNsaWNrIHx8IHRoaXMucHJvcHMudmFsdWUuaHJlZiA/IChcblx0XHRcdDxhIGNsYXNzTmFtZT17Y2xhc3NOYW1lfSBocmVmPXt0aGlzLnByb3BzLnZhbHVlLmhyZWZ9IHRhcmdldD17dGhpcy5wcm9wcy52YWx1ZS50YXJnZXR9IG9uTW91c2VEb3duPXt0aGlzLmhhbmRsZU1vdXNlRG93bn0gb25Ub3VjaEVuZD17dGhpcy5oYW5kbGVNb3VzZURvd259PlxuXHRcdFx0XHR7dGhpcy5wcm9wcy5jaGlsZHJlbn1cblx0XHRcdDwvYT5cblx0XHQpIDogKFxuXHRcdFx0PHNwYW4gY2xhc3NOYW1lPXtjbGFzc05hbWV9PlxuXHRcdFx0XHR7dGhpcy5wcm9wcy5jaGlsZHJlbn1cblx0XHRcdDwvc3Bhbj5cblx0XHQpO1xuXHR9LFxuXG5cdHJlbmRlciAoKSB7XG5cdFx0cmV0dXJuIChcblx0XHRcdDxkaXYgY2xhc3NOYW1lPXtjbGFzc05hbWVzKCdTZWxlY3QtdmFsdWUnLCB0aGlzLnByb3BzLnZhbHVlLmNsYXNzTmFtZSl9XG5cdFx0XHRcdHN0eWxlPXt0aGlzLnByb3BzLnZhbHVlLnN0eWxlfVxuXHRcdFx0XHR0aXRsZT17dGhpcy5wcm9wcy52YWx1ZS50aXRsZX1cblx0XHRcdFx0PlxuXHRcdFx0XHR7dGhpcy5yZW5kZXJSZW1vdmVJY29uKCl9XG5cdFx0XHRcdHt0aGlzLnJlbmRlckxhYmVsKCl9XG5cdFx0XHQ8L2Rpdj5cblx0XHQpO1xuXHR9XG5cbn0pO1xuXG5tb2R1bGUuZXhwb3J0cyA9IFZhbHVlO1xuIiwidmFyIG1hcCA9IFtcblx0eyAnYmFzZSc6J0EnLCAnbGV0dGVycyc6L1tcXHUwMDQxXFx1MjRCNlxcdUZGMjFcXHUwMEMwXFx1MDBDMVxcdTAwQzJcXHUxRUE2XFx1MUVBNFxcdTFFQUFcXHUxRUE4XFx1MDBDM1xcdTAxMDBcXHUwMTAyXFx1MUVCMFxcdTFFQUVcXHUxRUI0XFx1MUVCMlxcdTAyMjZcXHUwMUUwXFx1MDBDNFxcdTAxREVcXHUxRUEyXFx1MDBDNVxcdTAxRkFcXHUwMUNEXFx1MDIwMFxcdTAyMDJcXHUxRUEwXFx1MUVBQ1xcdTFFQjZcXHUxRTAwXFx1MDEwNFxcdTAyM0FcXHUyQzZGXS9nIH0sXG5cdHsgJ2Jhc2UnOidBQScsJ2xldHRlcnMnOi9bXFx1QTczMl0vZyB9LFxuXHR7ICdiYXNlJzonQUUnLCdsZXR0ZXJzJzovW1xcdTAwQzZcXHUwMUZDXFx1MDFFMl0vZyB9LFxuXHR7ICdiYXNlJzonQU8nLCdsZXR0ZXJzJzovW1xcdUE3MzRdL2cgfSxcblx0eyAnYmFzZSc6J0FVJywnbGV0dGVycyc6L1tcXHVBNzM2XS9nIH0sXG5cdHsgJ2Jhc2UnOidBVicsJ2xldHRlcnMnOi9bXFx1QTczOFxcdUE3M0FdL2cgfSxcblx0eyAnYmFzZSc6J0FZJywnbGV0dGVycyc6L1tcXHVBNzNDXS9nIH0sXG5cdHsgJ2Jhc2UnOidCJywgJ2xldHRlcnMnOi9bXFx1MDA0MlxcdTI0QjdcXHVGRjIyXFx1MUUwMlxcdTFFMDRcXHUxRTA2XFx1MDI0M1xcdTAxODJcXHUwMTgxXS9nIH0sXG5cdHsgJ2Jhc2UnOidDJywgJ2xldHRlcnMnOi9bXFx1MDA0M1xcdTI0QjhcXHVGRjIzXFx1MDEwNlxcdTAxMDhcXHUwMTBBXFx1MDEwQ1xcdTAwQzdcXHUxRTA4XFx1MDE4N1xcdTAyM0JcXHVBNzNFXS9nIH0sXG5cdHsgJ2Jhc2UnOidEJywgJ2xldHRlcnMnOi9bXFx1MDA0NFxcdTI0QjlcXHVGRjI0XFx1MUUwQVxcdTAxMEVcXHUxRTBDXFx1MUUxMFxcdTFFMTJcXHUxRTBFXFx1MDExMFxcdTAxOEJcXHUwMThBXFx1MDE4OVxcdUE3NzldL2cgfSxcblx0eyAnYmFzZSc6J0RaJywnbGV0dGVycyc6L1tcXHUwMUYxXFx1MDFDNF0vZyB9LFxuXHR7ICdiYXNlJzonRHonLCdsZXR0ZXJzJzovW1xcdTAxRjJcXHUwMUM1XS9nIH0sXG5cdHsgJ2Jhc2UnOidFJywgJ2xldHRlcnMnOi9bXFx1MDA0NVxcdTI0QkFcXHVGRjI1XFx1MDBDOFxcdTAwQzlcXHUwMENBXFx1MUVDMFxcdTFFQkVcXHUxRUM0XFx1MUVDMlxcdTFFQkNcXHUwMTEyXFx1MUUxNFxcdTFFMTZcXHUwMTE0XFx1MDExNlxcdTAwQ0JcXHUxRUJBXFx1MDExQVxcdTAyMDRcXHUwMjA2XFx1MUVCOFxcdTFFQzZcXHUwMjI4XFx1MUUxQ1xcdTAxMThcXHUxRTE4XFx1MUUxQVxcdTAxOTBcXHUwMThFXS9nIH0sXG5cdHsgJ2Jhc2UnOidGJywgJ2xldHRlcnMnOi9bXFx1MDA0NlxcdTI0QkJcXHVGRjI2XFx1MUUxRVxcdTAxOTFcXHVBNzdCXS9nIH0sXG5cdHsgJ2Jhc2UnOidHJywgJ2xldHRlcnMnOi9bXFx1MDA0N1xcdTI0QkNcXHVGRjI3XFx1MDFGNFxcdTAxMUNcXHUxRTIwXFx1MDExRVxcdTAxMjBcXHUwMUU2XFx1MDEyMlxcdTAxRTRcXHUwMTkzXFx1QTdBMFxcdUE3N0RcXHVBNzdFXS9nIH0sXG5cdHsgJ2Jhc2UnOidIJywgJ2xldHRlcnMnOi9bXFx1MDA0OFxcdTI0QkRcXHVGRjI4XFx1MDEyNFxcdTFFMjJcXHUxRTI2XFx1MDIxRVxcdTFFMjRcXHUxRTI4XFx1MUUyQVxcdTAxMjZcXHUyQzY3XFx1MkM3NVxcdUE3OERdL2cgfSxcblx0eyAnYmFzZSc6J0knLCAnbGV0dGVycyc6L1tcXHUwMDQ5XFx1MjRCRVxcdUZGMjlcXHUwMENDXFx1MDBDRFxcdTAwQ0VcXHUwMTI4XFx1MDEyQVxcdTAxMkNcXHUwMTMwXFx1MDBDRlxcdTFFMkVcXHUxRUM4XFx1MDFDRlxcdTAyMDhcXHUwMjBBXFx1MUVDQVxcdTAxMkVcXHUxRTJDXFx1MDE5N10vZyB9LFxuXHR7ICdiYXNlJzonSicsICdsZXR0ZXJzJzovW1xcdTAwNEFcXHUyNEJGXFx1RkYyQVxcdTAxMzRcXHUwMjQ4XS9nIH0sXG5cdHsgJ2Jhc2UnOidLJywgJ2xldHRlcnMnOi9bXFx1MDA0QlxcdTI0QzBcXHVGRjJCXFx1MUUzMFxcdTAxRThcXHUxRTMyXFx1MDEzNlxcdTFFMzRcXHUwMTk4XFx1MkM2OVxcdUE3NDBcXHVBNzQyXFx1QTc0NFxcdUE3QTJdL2cgfSxcblx0eyAnYmFzZSc6J0wnLCAnbGV0dGVycyc6L1tcXHUwMDRDXFx1MjRDMVxcdUZGMkNcXHUwMTNGXFx1MDEzOVxcdTAxM0RcXHUxRTM2XFx1MUUzOFxcdTAxM0JcXHUxRTNDXFx1MUUzQVxcdTAxNDFcXHUwMjNEXFx1MkM2MlxcdTJDNjBcXHVBNzQ4XFx1QTc0NlxcdUE3ODBdL2cgfSxcblx0eyAnYmFzZSc6J0xKJywnbGV0dGVycyc6L1tcXHUwMUM3XS9nIH0sXG5cdHsgJ2Jhc2UnOidMaicsJ2xldHRlcnMnOi9bXFx1MDFDOF0vZyB9LFxuXHR7ICdiYXNlJzonTScsICdsZXR0ZXJzJzovW1xcdTAwNERcXHUyNEMyXFx1RkYyRFxcdTFFM0VcXHUxRTQwXFx1MUU0MlxcdTJDNkVcXHUwMTlDXS9nIH0sXG5cdHsgJ2Jhc2UnOidOJywgJ2xldHRlcnMnOi9bXFx1MDA0RVxcdTI0QzNcXHVGRjJFXFx1MDFGOFxcdTAxNDNcXHUwMEQxXFx1MUU0NFxcdTAxNDdcXHUxRTQ2XFx1MDE0NVxcdTFFNEFcXHUxRTQ4XFx1MDIyMFxcdTAxOURcXHVBNzkwXFx1QTdBNF0vZyB9LFxuXHR7ICdiYXNlJzonTkonLCdsZXR0ZXJzJzovW1xcdTAxQ0FdL2cgfSxcblx0eyAnYmFzZSc6J05qJywnbGV0dGVycyc6L1tcXHUwMUNCXS9nIH0sXG5cdHsgJ2Jhc2UnOidPJywgJ2xldHRlcnMnOi9bXFx1MDA0RlxcdTI0QzRcXHVGRjJGXFx1MDBEMlxcdTAwRDNcXHUwMEQ0XFx1MUVEMlxcdTFFRDBcXHUxRUQ2XFx1MUVENFxcdTAwRDVcXHUxRTRDXFx1MDIyQ1xcdTFFNEVcXHUwMTRDXFx1MUU1MFxcdTFFNTJcXHUwMTRFXFx1MDIyRVxcdTAyMzBcXHUwMEQ2XFx1MDIyQVxcdTFFQ0VcXHUwMTUwXFx1MDFEMVxcdTAyMENcXHUwMjBFXFx1MDFBMFxcdTFFRENcXHUxRURBXFx1MUVFMFxcdTFFREVcXHUxRUUyXFx1MUVDQ1xcdTFFRDhcXHUwMUVBXFx1MDFFQ1xcdTAwRDhcXHUwMUZFXFx1MDE4NlxcdTAxOUZcXHVBNzRBXFx1QTc0Q10vZyB9LFxuXHR7ICdiYXNlJzonT0knLCdsZXR0ZXJzJzovW1xcdTAxQTJdL2cgfSxcblx0eyAnYmFzZSc6J09PJywnbGV0dGVycyc6L1tcXHVBNzRFXS9nIH0sXG5cdHsgJ2Jhc2UnOidPVScsJ2xldHRlcnMnOi9bXFx1MDIyMl0vZyB9LFxuXHR7ICdiYXNlJzonUCcsICdsZXR0ZXJzJzovW1xcdTAwNTBcXHUyNEM1XFx1RkYzMFxcdTFFNTRcXHUxRTU2XFx1MDFBNFxcdTJDNjNcXHVBNzUwXFx1QTc1MlxcdUE3NTRdL2cgfSxcblx0eyAnYmFzZSc6J1EnLCAnbGV0dGVycyc6L1tcXHUwMDUxXFx1MjRDNlxcdUZGMzFcXHVBNzU2XFx1QTc1OFxcdTAyNEFdL2cgfSxcblx0eyAnYmFzZSc6J1InLCAnbGV0dGVycyc6L1tcXHUwMDUyXFx1MjRDN1xcdUZGMzJcXHUwMTU0XFx1MUU1OFxcdTAxNThcXHUwMjEwXFx1MDIxMlxcdTFFNUFcXHUxRTVDXFx1MDE1NlxcdTFFNUVcXHUwMjRDXFx1MkM2NFxcdUE3NUFcXHVBN0E2XFx1QTc4Ml0vZyB9LFxuXHR7ICdiYXNlJzonUycsICdsZXR0ZXJzJzovW1xcdTAwNTNcXHUyNEM4XFx1RkYzM1xcdTFFOUVcXHUwMTVBXFx1MUU2NFxcdTAxNUNcXHUxRTYwXFx1MDE2MFxcdTFFNjZcXHUxRTYyXFx1MUU2OFxcdTAyMThcXHUwMTVFXFx1MkM3RVxcdUE3QThcXHVBNzg0XS9nIH0sXG5cdHsgJ2Jhc2UnOidUJywgJ2xldHRlcnMnOi9bXFx1MDA1NFxcdTI0QzlcXHVGRjM0XFx1MUU2QVxcdTAxNjRcXHUxRTZDXFx1MDIxQVxcdTAxNjJcXHUxRTcwXFx1MUU2RVxcdTAxNjZcXHUwMUFDXFx1MDFBRVxcdTAyM0VcXHVBNzg2XS9nIH0sXG5cdHsgJ2Jhc2UnOidUWicsJ2xldHRlcnMnOi9bXFx1QTcyOF0vZyB9LFxuXHR7ICdiYXNlJzonVScsICdsZXR0ZXJzJzovW1xcdTAwNTVcXHUyNENBXFx1RkYzNVxcdTAwRDlcXHUwMERBXFx1MDBEQlxcdTAxNjhcXHUxRTc4XFx1MDE2QVxcdTFFN0FcXHUwMTZDXFx1MDBEQ1xcdTAxREJcXHUwMUQ3XFx1MDFENVxcdTAxRDlcXHUxRUU2XFx1MDE2RVxcdTAxNzBcXHUwMUQzXFx1MDIxNFxcdTAyMTZcXHUwMUFGXFx1MUVFQVxcdTFFRThcXHUxRUVFXFx1MUVFQ1xcdTFFRjBcXHUxRUU0XFx1MUU3MlxcdTAxNzJcXHUxRTc2XFx1MUU3NFxcdTAyNDRdL2cgfSxcblx0eyAnYmFzZSc6J1YnLCAnbGV0dGVycyc6L1tcXHUwMDU2XFx1MjRDQlxcdUZGMzZcXHUxRTdDXFx1MUU3RVxcdTAxQjJcXHVBNzVFXFx1MDI0NV0vZyB9LFxuXHR7ICdiYXNlJzonVlknLCdsZXR0ZXJzJzovW1xcdUE3NjBdL2cgfSxcblx0eyAnYmFzZSc6J1cnLCAnbGV0dGVycyc6L1tcXHUwMDU3XFx1MjRDQ1xcdUZGMzdcXHUxRTgwXFx1MUU4MlxcdTAxNzRcXHUxRTg2XFx1MUU4NFxcdTFFODhcXHUyQzcyXS9nIH0sXG5cdHsgJ2Jhc2UnOidYJywgJ2xldHRlcnMnOi9bXFx1MDA1OFxcdTI0Q0RcXHVGRjM4XFx1MUU4QVxcdTFFOENdL2cgfSxcblx0eyAnYmFzZSc6J1knLCAnbGV0dGVycyc6L1tcXHUwMDU5XFx1MjRDRVxcdUZGMzlcXHUxRUYyXFx1MDBERFxcdTAxNzZcXHUxRUY4XFx1MDIzMlxcdTFFOEVcXHUwMTc4XFx1MUVGNlxcdTFFRjRcXHUwMUIzXFx1MDI0RVxcdTFFRkVdL2cgfSxcblx0eyAnYmFzZSc6J1onLCAnbGV0dGVycyc6L1tcXHUwMDVBXFx1MjRDRlxcdUZGM0FcXHUwMTc5XFx1MUU5MFxcdTAxN0JcXHUwMTdEXFx1MUU5MlxcdTFFOTRcXHUwMUI1XFx1MDIyNFxcdTJDN0ZcXHUyQzZCXFx1QTc2Ml0vZyB9LFxuXHR7ICdiYXNlJzonYScsICdsZXR0ZXJzJzovW1xcdTAwNjFcXHUyNEQwXFx1RkY0MVxcdTFFOUFcXHUwMEUwXFx1MDBFMVxcdTAwRTJcXHUxRUE3XFx1MUVBNVxcdTFFQUJcXHUxRUE5XFx1MDBFM1xcdTAxMDFcXHUwMTAzXFx1MUVCMVxcdTFFQUZcXHUxRUI1XFx1MUVCM1xcdTAyMjdcXHUwMUUxXFx1MDBFNFxcdTAxREZcXHUxRUEzXFx1MDBFNVxcdTAxRkJcXHUwMUNFXFx1MDIwMVxcdTAyMDNcXHUxRUExXFx1MUVBRFxcdTFFQjdcXHUxRTAxXFx1MDEwNVxcdTJDNjVcXHUwMjUwXS9nIH0sXG5cdHsgJ2Jhc2UnOidhYScsJ2xldHRlcnMnOi9bXFx1QTczM10vZyB9LFxuXHR7ICdiYXNlJzonYWUnLCdsZXR0ZXJzJzovW1xcdTAwRTZcXHUwMUZEXFx1MDFFM10vZyB9LFxuXHR7ICdiYXNlJzonYW8nLCdsZXR0ZXJzJzovW1xcdUE3MzVdL2cgfSxcblx0eyAnYmFzZSc6J2F1JywnbGV0dGVycyc6L1tcXHVBNzM3XS9nIH0sXG5cdHsgJ2Jhc2UnOidhdicsJ2xldHRlcnMnOi9bXFx1QTczOVxcdUE3M0JdL2cgfSxcblx0eyAnYmFzZSc6J2F5JywnbGV0dGVycyc6L1tcXHVBNzNEXS9nIH0sXG5cdHsgJ2Jhc2UnOidiJywgJ2xldHRlcnMnOi9bXFx1MDA2MlxcdTI0RDFcXHVGRjQyXFx1MUUwM1xcdTFFMDVcXHUxRTA3XFx1MDE4MFxcdTAxODNcXHUwMjUzXS9nIH0sXG5cdHsgJ2Jhc2UnOidjJywgJ2xldHRlcnMnOi9bXFx1MDA2M1xcdTI0RDJcXHVGRjQzXFx1MDEwN1xcdTAxMDlcXHUwMTBCXFx1MDEwRFxcdTAwRTdcXHUxRTA5XFx1MDE4OFxcdTAyM0NcXHVBNzNGXFx1MjE4NF0vZyB9LFxuXHR7ICdiYXNlJzonZCcsICdsZXR0ZXJzJzovW1xcdTAwNjRcXHUyNEQzXFx1RkY0NFxcdTFFMEJcXHUwMTBGXFx1MUUwRFxcdTFFMTFcXHUxRTEzXFx1MUUwRlxcdTAxMTFcXHUwMThDXFx1MDI1NlxcdTAyNTdcXHVBNzdBXS9nIH0sXG5cdHsgJ2Jhc2UnOidkeicsJ2xldHRlcnMnOi9bXFx1MDFGM1xcdTAxQzZdL2cgfSxcblx0eyAnYmFzZSc6J2UnLCAnbGV0dGVycyc6L1tcXHUwMDY1XFx1MjRENFxcdUZGNDVcXHUwMEU4XFx1MDBFOVxcdTAwRUFcXHUxRUMxXFx1MUVCRlxcdTFFQzVcXHUxRUMzXFx1MUVCRFxcdTAxMTNcXHUxRTE1XFx1MUUxN1xcdTAxMTVcXHUwMTE3XFx1MDBFQlxcdTFFQkJcXHUwMTFCXFx1MDIwNVxcdTAyMDdcXHUxRUI5XFx1MUVDN1xcdTAyMjlcXHUxRTFEXFx1MDExOVxcdTFFMTlcXHUxRTFCXFx1MDI0N1xcdTAyNUJcXHUwMUREXS9nIH0sXG5cdHsgJ2Jhc2UnOidmJywgJ2xldHRlcnMnOi9bXFx1MDA2NlxcdTI0RDVcXHVGRjQ2XFx1MUUxRlxcdTAxOTJcXHVBNzdDXS9nIH0sXG5cdHsgJ2Jhc2UnOidnJywgJ2xldHRlcnMnOi9bXFx1MDA2N1xcdTI0RDZcXHVGRjQ3XFx1MDFGNVxcdTAxMURcXHUxRTIxXFx1MDExRlxcdTAxMjFcXHUwMUU3XFx1MDEyM1xcdTAxRTVcXHUwMjYwXFx1QTdBMVxcdTFENzlcXHVBNzdGXS9nIH0sXG5cdHsgJ2Jhc2UnOidoJywgJ2xldHRlcnMnOi9bXFx1MDA2OFxcdTI0RDdcXHVGRjQ4XFx1MDEyNVxcdTFFMjNcXHUxRTI3XFx1MDIxRlxcdTFFMjVcXHUxRTI5XFx1MUUyQlxcdTFFOTZcXHUwMTI3XFx1MkM2OFxcdTJDNzZcXHUwMjY1XS9nIH0sXG5cdHsgJ2Jhc2UnOidodicsJ2xldHRlcnMnOi9bXFx1MDE5NV0vZyB9LFxuXHR7ICdiYXNlJzonaScsICdsZXR0ZXJzJzovW1xcdTAwNjlcXHUyNEQ4XFx1RkY0OVxcdTAwRUNcXHUwMEVEXFx1MDBFRVxcdTAxMjlcXHUwMTJCXFx1MDEyRFxcdTAwRUZcXHUxRTJGXFx1MUVDOVxcdTAxRDBcXHUwMjA5XFx1MDIwQlxcdTFFQ0JcXHUwMTJGXFx1MUUyRFxcdTAyNjhcXHUwMTMxXS9nIH0sXG5cdHsgJ2Jhc2UnOidqJywgJ2xldHRlcnMnOi9bXFx1MDA2QVxcdTI0RDlcXHVGRjRBXFx1MDEzNVxcdTAxRjBcXHUwMjQ5XS9nIH0sXG5cdHsgJ2Jhc2UnOidrJywgJ2xldHRlcnMnOi9bXFx1MDA2QlxcdTI0REFcXHVGRjRCXFx1MUUzMVxcdTAxRTlcXHUxRTMzXFx1MDEzN1xcdTFFMzVcXHUwMTk5XFx1MkM2QVxcdUE3NDFcXHVBNzQzXFx1QTc0NVxcdUE3QTNdL2cgfSxcblx0eyAnYmFzZSc6J2wnLCAnbGV0dGVycyc6L1tcXHUwMDZDXFx1MjREQlxcdUZGNENcXHUwMTQwXFx1MDEzQVxcdTAxM0VcXHUxRTM3XFx1MUUzOVxcdTAxM0NcXHUxRTNEXFx1MUUzQlxcdTAxN0ZcXHUwMTQyXFx1MDE5QVxcdTAyNkJcXHUyQzYxXFx1QTc0OVxcdUE3ODFcXHVBNzQ3XS9nIH0sXG5cdHsgJ2Jhc2UnOidsaicsJ2xldHRlcnMnOi9bXFx1MDFDOV0vZyB9LFxuXHR7ICdiYXNlJzonbScsICdsZXR0ZXJzJzovW1xcdTAwNkRcXHUyNERDXFx1RkY0RFxcdTFFM0ZcXHUxRTQxXFx1MUU0M1xcdTAyNzFcXHUwMjZGXS9nIH0sXG5cdHsgJ2Jhc2UnOiduJywgJ2xldHRlcnMnOi9bXFx1MDA2RVxcdTI0RERcXHVGRjRFXFx1MDFGOVxcdTAxNDRcXHUwMEYxXFx1MUU0NVxcdTAxNDhcXHUxRTQ3XFx1MDE0NlxcdTFFNEJcXHUxRTQ5XFx1MDE5RVxcdTAyNzJcXHUwMTQ5XFx1QTc5MVxcdUE3QTVdL2cgfSxcblx0eyAnYmFzZSc6J25qJywnbGV0dGVycyc6L1tcXHUwMUNDXS9nIH0sXG5cdHsgJ2Jhc2UnOidvJywgJ2xldHRlcnMnOi9bXFx1MDA2RlxcdTI0REVcXHVGRjRGXFx1MDBGMlxcdTAwRjNcXHUwMEY0XFx1MUVEM1xcdTFFRDFcXHUxRUQ3XFx1MUVENVxcdTAwRjVcXHUxRTREXFx1MDIyRFxcdTFFNEZcXHUwMTREXFx1MUU1MVxcdTFFNTNcXHUwMTRGXFx1MDIyRlxcdTAyMzFcXHUwMEY2XFx1MDIyQlxcdTFFQ0ZcXHUwMTUxXFx1MDFEMlxcdTAyMERcXHUwMjBGXFx1MDFBMVxcdTFFRERcXHUxRURCXFx1MUVFMVxcdTFFREZcXHUxRUUzXFx1MUVDRFxcdTFFRDlcXHUwMUVCXFx1MDFFRFxcdTAwRjhcXHUwMUZGXFx1MDI1NFxcdUE3NEJcXHVBNzREXFx1MDI3NV0vZyB9LFxuXHR7ICdiYXNlJzonb2knLCdsZXR0ZXJzJzovW1xcdTAxQTNdL2cgfSxcblx0eyAnYmFzZSc6J291JywnbGV0dGVycyc6L1tcXHUwMjIzXS9nIH0sXG5cdHsgJ2Jhc2UnOidvbycsJ2xldHRlcnMnOi9bXFx1QTc0Rl0vZyB9LFxuXHR7ICdiYXNlJzoncCcsICdsZXR0ZXJzJzovW1xcdTAwNzBcXHUyNERGXFx1RkY1MFxcdTFFNTVcXHUxRTU3XFx1MDFBNVxcdTFEN0RcXHVBNzUxXFx1QTc1M1xcdUE3NTVdL2cgfSxcblx0eyAnYmFzZSc6J3EnLCAnbGV0dGVycyc6L1tcXHUwMDcxXFx1MjRFMFxcdUZGNTFcXHUwMjRCXFx1QTc1N1xcdUE3NTldL2cgfSxcblx0eyAnYmFzZSc6J3InLCAnbGV0dGVycyc6L1tcXHUwMDcyXFx1MjRFMVxcdUZGNTJcXHUwMTU1XFx1MUU1OVxcdTAxNTlcXHUwMjExXFx1MDIxM1xcdTFFNUJcXHUxRTVEXFx1MDE1N1xcdTFFNUZcXHUwMjREXFx1MDI3RFxcdUE3NUJcXHVBN0E3XFx1QTc4M10vZyB9LFxuXHR7ICdiYXNlJzoncycsICdsZXR0ZXJzJzovW1xcdTAwNzNcXHUyNEUyXFx1RkY1M1xcdTAwREZcXHUwMTVCXFx1MUU2NVxcdTAxNURcXHUxRTYxXFx1MDE2MVxcdTFFNjdcXHUxRTYzXFx1MUU2OVxcdTAyMTlcXHUwMTVGXFx1MDIzRlxcdUE3QTlcXHVBNzg1XFx1MUU5Ql0vZyB9LFxuXHR7ICdiYXNlJzondCcsICdsZXR0ZXJzJzovW1xcdTAwNzRcXHUyNEUzXFx1RkY1NFxcdTFFNkJcXHUxRTk3XFx1MDE2NVxcdTFFNkRcXHUwMjFCXFx1MDE2M1xcdTFFNzFcXHUxRTZGXFx1MDE2N1xcdTAxQURcXHUwMjg4XFx1MkM2NlxcdUE3ODddL2cgfSxcblx0eyAnYmFzZSc6J3R6JywnbGV0dGVycyc6L1tcXHVBNzI5XS9nIH0sXG5cdHsgJ2Jhc2UnOid1JywgJ2xldHRlcnMnOi9bXFx1MDA3NVxcdTI0RTRcXHVGRjU1XFx1MDBGOVxcdTAwRkFcXHUwMEZCXFx1MDE2OVxcdTFFNzlcXHUwMTZCXFx1MUU3QlxcdTAxNkRcXHUwMEZDXFx1MDFEQ1xcdTAxRDhcXHUwMUQ2XFx1MDFEQVxcdTFFRTdcXHUwMTZGXFx1MDE3MVxcdTAxRDRcXHUwMjE1XFx1MDIxN1xcdTAxQjBcXHUxRUVCXFx1MUVFOVxcdTFFRUZcXHUxRUVEXFx1MUVGMVxcdTFFRTVcXHUxRTczXFx1MDE3M1xcdTFFNzdcXHUxRTc1XFx1MDI4OV0vZyB9LFxuXHR7ICdiYXNlJzondicsICdsZXR0ZXJzJzovW1xcdTAwNzZcXHUyNEU1XFx1RkY1NlxcdTFFN0RcXHUxRTdGXFx1MDI4QlxcdUE3NUZcXHUwMjhDXS9nIH0sXG5cdHsgJ2Jhc2UnOid2eScsJ2xldHRlcnMnOi9bXFx1QTc2MV0vZyB9LFxuXHR7ICdiYXNlJzondycsICdsZXR0ZXJzJzovW1xcdTAwNzdcXHUyNEU2XFx1RkY1N1xcdTFFODFcXHUxRTgzXFx1MDE3NVxcdTFFODdcXHUxRTg1XFx1MUU5OFxcdTFFODlcXHUyQzczXS9nIH0sXG5cdHsgJ2Jhc2UnOid4JywgJ2xldHRlcnMnOi9bXFx1MDA3OFxcdTI0RTdcXHVGRjU4XFx1MUU4QlxcdTFFOERdL2cgfSxcblx0eyAnYmFzZSc6J3knLCAnbGV0dGVycyc6L1tcXHUwMDc5XFx1MjRFOFxcdUZGNTlcXHUxRUYzXFx1MDBGRFxcdTAxNzdcXHUxRUY5XFx1MDIzM1xcdTFFOEZcXHUwMEZGXFx1MUVGN1xcdTFFOTlcXHUxRUY1XFx1MDFCNFxcdTAyNEZcXHUxRUZGXS9nIH0sXG5cdHsgJ2Jhc2UnOid6JywgJ2xldHRlcnMnOi9bXFx1MDA3QVxcdTI0RTlcXHVGRjVBXFx1MDE3QVxcdTFFOTFcXHUwMTdDXFx1MDE3RVxcdTFFOTNcXHUxRTk1XFx1MDFCNlxcdTAyMjVcXHUwMjQwXFx1MkM2Q1xcdUE3NjNdL2cgfSxcbl07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gc3RyaXBEaWFjcml0aWNzIChzdHIpIHtcblx0Zm9yICh2YXIgaSA9IDA7IGkgPCBtYXAubGVuZ3RoOyBpKyspIHtcblx0XHRzdHIgPSBzdHIucmVwbGFjZShtYXBbaV0ubGV0dGVycywgbWFwW2ldLmJhc2UpO1xuXHR9XG5cdHJldHVybiBzdHI7XG59O1xuIiwiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCBSZWFjdERPTSBmcm9tICdyZWFjdC1kb20nO1xuaW1wb3J0IElucHV0IGZyb20gJ3JlYWN0LWlucHV0LWF1dG9zaXplJztcbmltcG9ydCBjbGFzc05hbWVzIGZyb20gJ2NsYXNzbmFtZXMnO1xuXG5pbXBvcnQgc3RyaXBEaWFjcml0aWNzIGZyb20gJy4vdXRpbHMvc3RyaXBEaWFjcml0aWNzJztcblxuaW1wb3J0IEFzeW5jIGZyb20gJy4vQXN5bmMnO1xuaW1wb3J0IE9wdGlvbiBmcm9tICcuL09wdGlvbic7XG5pbXBvcnQgVmFsdWUgZnJvbSAnLi9WYWx1ZSc7XG5pbXBvcnQge0RyYWdnYWJsZVNlbGVjdCwgRHJhZ2dhYmxlVmFsdWV9IGZyb20gJy4vRHJhZ2dhYmxlJztcbmltcG9ydCB7RHJhZ0Ryb3BDb250ZXh0fSBmcm9tICdyZWFjdC1kbmQnO1xuaW1wb3J0IEhUTUw1QmFja2VuZCBmcm9tICdyZWFjdC1kbmQtaHRtbDUtYmFja2VuZCc7XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeVZhbHVlICh2YWx1ZSkge1xuXHRpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuXHRcdHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG5cdH0gZWxzZSB7XG5cdFx0cmV0dXJuIHZhbHVlO1xuXHR9XG59XG5cbmNvbnN0IHN0cmluZ09yTm9kZSA9IFJlYWN0LlByb3BUeXBlcy5vbmVPZlR5cGUoW1xuXHRSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLFxuXHRSZWFjdC5Qcm9wVHlwZXMubm9kZVxuXSk7XG5cbmNvbnN0IFNlbGVjdCA9IFJlYWN0LmNyZWF0ZUNsYXNzKHtcblxuXHRkaXNwbGF5TmFtZTogJ1NlbGVjdCcsXG5cblx0cHJvcFR5cGVzOiB7XG5cdFx0YWRkTGFiZWxUZXh0OiBSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLCAgICAgICAvLyBwbGFjZWhvbGRlciBkaXNwbGF5ZWQgd2hlbiB5b3Ugd2FudCB0byBhZGQgYSBsYWJlbCBvbiBhIG11bHRpLXZhbHVlIGlucHV0XG5cdFx0YWxsb3dDcmVhdGU6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgICAgICAgICAvLyB3aGV0aGVyIHRvIGFsbG93IGNyZWF0aW9uIG9mIG5ldyBlbnRyaWVzXG5cdFx0b3Blbk9uRm9jdXM6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgICAgICAgICAvLyBhbHdheXMgb3BlbiBvcHRpb25zIG1lbnUgb24gZm9jdXNcblx0XHRhdXRvQmx1cjogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgIC8vIGF1dG9tYXRpY2FsbHkgYmx1ciB0aGUgY29tcG9uZW50IHdoZW4gYW4gb3B0aW9uIGlzIHNlbGVjdGVkXG5cdFx0YXV0b2ZvY3VzOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAvLyBhdXRvZm9jdXMgdGhlIGNvbXBvbmVudCBvbiBtb3VudFxuXHRcdGF1dG9zaXplOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgLy8gd2hldGhlciB0byBlbmFibGUgYXV0b3NpemluZyBvciBub3Rcblx0XHRiYWNrc3BhY2VSZW1vdmVzOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgIC8vIHdoZXRoZXIgYmFja3NwYWNlIHJlbW92ZXMgYW4gaXRlbSBpZiB0aGVyZSBpcyBubyB0ZXh0IGlucHV0XG5cdFx0Y2xhc3NOYW1lOiBSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLCAgICAgICAgICAvLyBjbGFzc05hbWUgZm9yIHRoZSBvdXRlciBlbGVtZW50XG5cdFx0Y2xlYXJBbGxUZXh0OiBzdHJpbmdPck5vZGUsICAgICAgICAgICAgICAgICAvLyB0aXRsZSBmb3IgdGhlIFwiY2xlYXJcIiBjb250cm9sIHdoZW4gbXVsdGk6IHRydWVcblx0XHRjbGVhclZhbHVlVGV4dDogc3RyaW5nT3JOb2RlLCAgICAgICAgICAgICAgIC8vIHRpdGxlIGZvciB0aGUgXCJjbGVhclwiIGNvbnRyb2xcblx0XHRjbGVhcmFibGU6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgICAgICAgICAgIC8vIHNob3VsZCBpdCBiZSBwb3NzaWJsZSB0byByZXNldCB2YWx1ZVxuXHRcdGRlbGltaXRlcjogUmVhY3QuUHJvcFR5cGVzLnN0cmluZywgICAgICAgICAgLy8gZGVsaW1pdGVyIHRvIHVzZSB0byBqb2luIG11bHRpcGxlIHZhbHVlcyBmb3IgdGhlIGhpZGRlbiBmaWVsZCB2YWx1ZVxuXHRcdGRpc2FibGVkOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgLy8gd2hldGhlciB0aGUgU2VsZWN0IGlzIGRpc2FibGVkIG9yIG5vdFxuXHRcdGVzY2FwZUNsZWFyc1ZhbHVlOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgLy8gd2hldGhlciBlc2NhcGUgY2xlYXJzIHRoZSB2YWx1ZSB3aGVuIHRoZSBtZW51IGlzIGNsb3NlZFxuXHRcdGZpbHRlck9wdGlvbjogUmVhY3QuUHJvcFR5cGVzLmZ1bmMsICAgICAgICAgLy8gbWV0aG9kIHRvIGZpbHRlciBhIHNpbmdsZSBvcHRpb24gKG9wdGlvbiwgZmlsdGVyU3RyaW5nKVxuXHRcdGZpbHRlck9wdGlvbnM6IFJlYWN0LlByb3BUeXBlcy5hbnksICAgICAgICAgLy8gYm9vbGVhbiB0byBlbmFibGUgZGVmYXVsdCBmaWx0ZXJpbmcgb3IgZnVuY3Rpb24gdG8gZmlsdGVyIHRoZSBvcHRpb25zIGFycmF5IChbb3B0aW9uc10sIGZpbHRlclN0cmluZywgW3ZhbHVlc10pXG5cdFx0aWdub3JlQWNjZW50czogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAvLyB3aGV0aGVyIHRvIHN0cmlwIGRpYWNyaXRpY3Mgd2hlbiBmaWx0ZXJpbmdcblx0XHRpZ25vcmVDYXNlOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgIC8vIHdoZXRoZXIgdG8gcGVyZm9ybSBjYXNlLWluc2Vuc2l0aXZlIGZpbHRlcmluZ1xuXHRcdGlucHV0UHJvcHM6IFJlYWN0LlByb3BUeXBlcy5vYmplY3QsICAgICAgICAgLy8gY3VzdG9tIGF0dHJpYnV0ZXMgZm9yIHRoZSBJbnB1dFxuXHRcdGlzTG9hZGluZzogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAgLy8gd2hldGhlciB0aGUgU2VsZWN0IGlzIGxvYWRpbmcgZXh0ZXJuYWxseSBvciBub3QgKHN1Y2ggYXMgb3B0aW9ucyBiZWluZyBsb2FkZWQpXG5cdFx0am9pblZhbHVlczogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgICAgICAvLyBqb2lucyBtdWx0aXBsZSB2YWx1ZXMgaW50byBhIHNpbmdsZSBmb3JtIGZpZWxkIHdpdGggdGhlIGRlbGltaXRlciAobGVnYWN5IG1vZGUpXG5cdFx0bGFiZWxLZXk6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgICAgICAgICAvLyBwYXRoIG9mIHRoZSBsYWJlbCB2YWx1ZSBpbiBvcHRpb24gb2JqZWN0c1xuXHRcdG1hdGNoUG9zOiBSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLCAgICAgICAgICAgLy8gKGFueXxzdGFydCkgbWF0Y2ggdGhlIHN0YXJ0IG9yIGVudGlyZSBzdHJpbmcgd2hlbiBmaWx0ZXJpbmdcblx0XHRtYXRjaFByb3A6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgICAgICAgIC8vIChhbnl8bGFiZWx8dmFsdWUpIHdoaWNoIG9wdGlvbiBwcm9wZXJ0eSB0byBmaWx0ZXIgb25cblx0XHRtZW51QnVmZmVyOiBSZWFjdC5Qcm9wVHlwZXMubnVtYmVyLCAgICAgICAgIC8vIG9wdGlvbmFsIGJ1ZmZlciAoaW4gcHgpIGJldHdlZW4gdGhlIGJvdHRvbSBvZiB0aGUgdmlld3BvcnQgYW5kIHRoZSBib3R0b20gb2YgdGhlIG1lbnVcblx0XHRtZW51Q29udGFpbmVyU3R5bGU6IFJlYWN0LlByb3BUeXBlcy5vYmplY3QsIC8vIG9wdGlvbmFsIHN0eWxlIHRvIGFwcGx5IHRvIHRoZSBtZW51IGNvbnRhaW5lclxuXHRcdG1lbnVSZW5kZXJlcjogUmVhY3QuUHJvcFR5cGVzLmZ1bmMsXHRcdFx0XHRcdC8vIHJlbmRlcnMgYSBjdXN0b20gbWVudSB3aXRoIG9wdGlvbnNcblx0XHRtZW51U3R5bGU6IFJlYWN0LlByb3BUeXBlcy5vYmplY3QsICAgICAgICAgIC8vIG9wdGlvbmFsIHN0eWxlIHRvIGFwcGx5IHRvIHRoZSBtZW51XG5cdFx0bXVsdGk6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgICAgICAgICAgICAgICAvLyBtdWx0aS12YWx1ZSBpbnB1dFxuXHRcdG5hbWU6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgICAgICAgICAgICAgLy8gZ2VuZXJhdGVzIGEgaGlkZGVuIDxpbnB1dCAvPiB0YWcgd2l0aCB0aGlzIGZpZWxkIG5hbWUgZm9yIGh0bWwgZm9ybXNcblx0XHRuZXdPcHRpb25DcmVhdG9yOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgIC8vIGZhY3RvcnkgdG8gY3JlYXRlIG5ldyBvcHRpb25zIHdoZW4gYWxsb3dDcmVhdGUgc2V0XG5cdFx0bm9SZXN1bHRzVGV4dDogc3RyaW5nT3JOb2RlLCAgICAgICAgICAgICAgICAvLyBwbGFjZWhvbGRlciBkaXNwbGF5ZWQgd2hlbiB0aGVyZSBhcmUgbm8gbWF0Y2hpbmcgc2VhcmNoIHJlc3VsdHNcblx0XHRvbkJsdXI6IFJlYWN0LlByb3BUeXBlcy5mdW5jLCAgICAgICAgICAgICAgIC8vIG9uQmx1ciBoYW5kbGVyOiBmdW5jdGlvbiAoZXZlbnQpIHt9XG5cdFx0b25CbHVyUmVzZXRzSW5wdXQ6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgICAvLyB3aGV0aGVyIGlucHV0IGlzIGNsZWFyZWQgb24gYmx1clxuXHRcdG9uQ2hhbmdlOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgLy8gb25DaGFuZ2UgaGFuZGxlcjogZnVuY3Rpb24gKG5ld1ZhbHVlKSB7fVxuXHRcdG9uQ2xvc2U6IFJlYWN0LlByb3BUeXBlcy5mdW5jLCAgICAgICAgICAgICAgLy8gZmlyZXMgd2hlbiB0aGUgbWVudSBpcyBjbG9zZWRcblx0XHRvbkZvY3VzOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgICAgICAgIC8vIG9uRm9jdXMgaGFuZGxlcjogZnVuY3Rpb24gKGV2ZW50KSB7fVxuXHRcdG9uSW5wdXRDaGFuZ2U6IFJlYWN0LlByb3BUeXBlcy5mdW5jLCAgICAgICAgLy8gb25JbnB1dENoYW5nZSBoYW5kbGVyOiBmdW5jdGlvbiAoaW5wdXRWYWx1ZSkge31cblx0XHRvbk1lbnVTY3JvbGxUb0JvdHRvbTogUmVhY3QuUHJvcFR5cGVzLmZ1bmMsIC8vIGZpcmVzIHdoZW4gdGhlIG1lbnUgaXMgc2Nyb2xsZWQgdG8gdGhlIGJvdHRvbTsgY2FuIGJlIHVzZWQgdG8gcGFnaW5hdGUgb3B0aW9uc1xuXHRcdG9uT3BlbjogUmVhY3QuUHJvcFR5cGVzLmZ1bmMsICAgICAgICAgICAgICAgLy8gZmlyZXMgd2hlbiB0aGUgbWVudSBpcyBvcGVuZWRcblx0XHRvblZhbHVlQ2xpY2s6IFJlYWN0LlByb3BUeXBlcy5mdW5jLCAgICAgICAgIC8vIG9uQ2xpY2sgaGFuZGxlciBmb3IgdmFsdWUgbGFiZWxzOiBmdW5jdGlvbiAodmFsdWUsIGV2ZW50KSB7fVxuXHRcdG9wZW5BZnRlckZvY3VzOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCxcdFx0Ly8gYm9vbGVhbiB0byBlbmFibGUgb3BlbmluZyBkcm9wZG93biB3aGVuIGZvY3VzZWRcblx0XHRvcHRpb25DbGFzc05hbWU6IFJlYWN0LlByb3BUeXBlcy5zdHJpbmcsICAgIC8vIGFkZGl0aW9uYWwgY2xhc3MoZXMpIHRvIGFwcGx5IHRvIHRoZSA8T3B0aW9uIC8+IGVsZW1lbnRzXG5cdFx0b3B0aW9uQ29tcG9uZW50OiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAvLyBvcHRpb24gY29tcG9uZW50IHRvIHJlbmRlciBpbiBkcm9wZG93blxuXHRcdG9wdGlvblJlbmRlcmVyOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgLy8gb3B0aW9uUmVuZGVyZXI6IGZ1bmN0aW9uIChvcHRpb24pIHt9XG5cdFx0b3B0aW9uczogUmVhY3QuUHJvcFR5cGVzLmFycmF5LCAgICAgICAgICAgICAvLyBhcnJheSBvZiBvcHRpb25zXG5cdFx0cGxhY2Vob2xkZXI6IHN0cmluZ09yTm9kZSwgICAgICAgICAgICAgICAgICAvLyBmaWVsZCBwbGFjZWhvbGRlciwgZGlzcGxheWVkIHdoZW4gdGhlcmUncyBubyB2YWx1ZVxuXHRcdHJlcXVpcmVkOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgICAgLy8gYXBwbGllcyBIVE1MNSByZXF1aXJlZCBhdHRyaWJ1dGUgd2hlbiBuZWVkZWRcblx0XHRzY3JvbGxNZW51SW50b1ZpZXc6IFJlYWN0LlByb3BUeXBlcy5ib29sLCAgIC8vIGJvb2xlYW4gdG8gZW5hYmxlIHRoZSB2aWV3cG9ydCB0byBzaGlmdCBzbyB0aGF0IHRoZSBmdWxsIG1lbnUgZnVsbHkgdmlzaWJsZSB3aGVuIGVuZ2FnZWRcblx0XHRzZWFyY2hhYmxlOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgIC8vIHdoZXRoZXIgdG8gZW5hYmxlIHNlYXJjaGluZyBmZWF0dXJlIG9yIG5vdFxuXHRcdHNpbXBsZVZhbHVlOiBSZWFjdC5Qcm9wVHlwZXMuYm9vbCwgICAgICAgICAgLy8gcGFzcyB0aGUgdmFsdWUgdG8gb25DaGFuZ2UgYXMgYSBzaW1wbGUgdmFsdWUgKGxlZ2FjeSBwcmUgMS4wIG1vZGUpLCBkZWZhdWx0cyB0byBmYWxzZVxuXHRcdHN0eWxlOiBSZWFjdC5Qcm9wVHlwZXMub2JqZWN0LCAgICAgICAgICAgICAgLy8gb3B0aW9uYWwgc3R5bGUgdG8gYXBwbHkgdG8gdGhlIGNvbnRyb2xcblx0XHR0YWJJbmRleDogUmVhY3QuUHJvcFR5cGVzLnN0cmluZywgICAgICAgICAgIC8vIG9wdGlvbmFsIHRhYiBpbmRleCBvZiB0aGUgY29udHJvbFxuXHRcdHRhYlNlbGVjdHNWYWx1ZTogUmVhY3QuUHJvcFR5cGVzLmJvb2wsICAgICAgLy8gd2hldGhlciB0byB0cmVhdCB0YWJiaW5nIG91dCB3aGlsZSBmb2N1c2VkIHRvIGJlIHZhbHVlIHNlbGVjdGlvblxuXHRcdHZhbHVlOiBSZWFjdC5Qcm9wVHlwZXMuYW55LCAgICAgICAgICAgICAgICAgLy8gaW5pdGlhbCBmaWVsZCB2YWx1ZVxuXHRcdHZhbHVlQ29tcG9uZW50OiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgLy8gdmFsdWUgY29tcG9uZW50IHRvIHJlbmRlclxuXHRcdHZhbHVlS2V5OiBSZWFjdC5Qcm9wVHlwZXMuc3RyaW5nLCAgICAgICAgICAgLy8gcGF0aCBvZiB0aGUgbGFiZWwgdmFsdWUgaW4gb3B0aW9uIG9iamVjdHNcblx0XHR2YWx1ZVJlbmRlcmVyOiBSZWFjdC5Qcm9wVHlwZXMuZnVuYywgICAgICAgIC8vIHZhbHVlUmVuZGVyZXI6IGZ1bmN0aW9uIChvcHRpb24pIHt9XG5cdFx0d3JhcHBlclN0eWxlOiBSZWFjdC5Qcm9wVHlwZXMub2JqZWN0LCAgICAgICAvLyBvcHRpb25hbCBzdHlsZSB0byBhcHBseSB0byB0aGUgY29tcG9uZW50IHdyYXBwZXJcblx0fSxcblxuXHRzdGF0aWNzOiB7IEFzeW5jIH0sXG5cblx0Z2V0RGVmYXVsdFByb3BzICgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0YWRkTGFiZWxUZXh0OiAnQWRkIFwie2xhYmVsfVwiPycsXG5cdFx0XHRhdXRvc2l6ZTogdHJ1ZSxcblx0XHRcdGFsbG93Q3JlYXRlOiBmYWxzZSxcblx0XHRcdGJhY2tzcGFjZVJlbW92ZXM6IHRydWUsXG5cdFx0XHRjbGVhcmFibGU6IHRydWUsXG5cdFx0XHRjbGVhckFsbFRleHQ6ICdDbGVhciBhbGwnLFxuXHRcdFx0Y2xlYXJWYWx1ZVRleHQ6ICdDbGVhciB2YWx1ZScsXG5cdFx0XHRkZWxpbWl0ZXI6ICcsJyxcblx0XHRcdGRpc2FibGVkOiBmYWxzZSxcblx0XHRcdGVzY2FwZUNsZWFyc1ZhbHVlOiB0cnVlLFxuXHRcdFx0ZmlsdGVyT3B0aW9uczogdHJ1ZSxcblx0XHRcdGlnbm9yZUFjY2VudHM6IHRydWUsXG5cdFx0XHRpZ25vcmVDYXNlOiB0cnVlLFxuXHRcdFx0aW5wdXRQcm9wczoge30sXG5cdFx0XHRpc0xvYWRpbmc6IGZhbHNlLFxuXHRcdFx0am9pblZhbHVlczogZmFsc2UsXG5cdFx0XHRsYWJlbEtleTogJ2xhYmVsJyxcblx0XHRcdG1hdGNoUG9zOiAnYW55Jyxcblx0XHRcdG1hdGNoUHJvcDogJ2FueScsXG5cdFx0XHRtZW51QnVmZmVyOiAwLFxuXHRcdFx0bXVsdGk6IGZhbHNlLFxuXHRcdFx0bm9SZXN1bHRzVGV4dDogJ05vIHJlc3VsdHMgZm91bmQnLFxuXHRcdFx0b25CbHVyUmVzZXRzSW5wdXQ6IHRydWUsXG5cdFx0XHRvcGVuQWZ0ZXJGb2N1czogZmFsc2UsXG5cdFx0XHRvcHRpb25Db21wb25lbnQ6IE9wdGlvbixcblx0XHRcdHBsYWNlaG9sZGVyOiAnU2VsZWN0Li4uJyxcblx0XHRcdHJlcXVpcmVkOiBmYWxzZSxcblx0XHRcdHNjcm9sbE1lbnVJbnRvVmlldzogdHJ1ZSxcblx0XHRcdHNlYXJjaGFibGU6IHRydWUsXG5cdFx0XHRzaW1wbGVWYWx1ZTogZmFsc2UsXG5cdFx0XHR0YWJTZWxlY3RzVmFsdWU6IHRydWUsXG5cdFx0XHR2YWx1ZUNvbXBvbmVudDogVmFsdWUsXG5cdFx0XHR2YWx1ZUtleTogJ3ZhbHVlJyxcblx0XHR9O1xuXHR9LFxuXG5cdGdldEluaXRpYWxTdGF0ZSAoKSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGlucHV0VmFsdWU6ICcnLFxuXHRcdFx0aXNGb2N1c2VkOiBmYWxzZSxcblx0XHRcdGlzTG9hZGluZzogZmFsc2UsXG5cdFx0XHRpc09wZW46IGZhbHNlLFxuXHRcdFx0aXNQc2V1ZG9Gb2N1c2VkOiBmYWxzZSxcblx0XHRcdHJlcXVpcmVkOiB0aGlzLnByb3BzLnJlcXVpcmVkICYmIHRoaXMuaGFuZGxlUmVxdWlyZWQodGhpcy5wcm9wcy52YWx1ZSwgdGhpcy5wcm9wcy5tdWx0aSlcblx0XHR9O1xuXHR9LFxuXG5cdGNvbXBvbmVudERpZE1vdW50ICgpIHtcblx0XHRpZiAodGhpcy5wcm9wcy5hdXRvZm9jdXMpIHtcblx0XHRcdHRoaXMuZm9jdXMoKTtcblx0XHR9XG5cdH0sXG5cblx0Y29tcG9uZW50V2lsbFJlY2VpdmVQcm9wcyhuZXh0UHJvcHMpIHtcblx0XHRpZiAodGhpcy5wcm9wcy52YWx1ZSAhPT0gbmV4dFByb3BzLnZhbHVlICYmIG5leHRQcm9wcy5yZXF1aXJlZCkge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRcdHJlcXVpcmVkOiB0aGlzLmhhbmRsZVJlcXVpcmVkKG5leHRQcm9wcy52YWx1ZSwgbmV4dFByb3BzLm11bHRpKSxcblx0XHRcdH0pO1xuXHRcdH1cblx0fSxcblxuXHRjb21wb25lbnRXaWxsVXBkYXRlIChuZXh0UHJvcHMsIG5leHRTdGF0ZSkge1xuXHRcdGlmIChuZXh0U3RhdGUuaXNPcGVuICE9PSB0aGlzLnN0YXRlLmlzT3Blbikge1xuXHRcdFx0Y29uc3QgaGFuZGxlciA9IG5leHRTdGF0ZS5pc09wZW4gPyBuZXh0UHJvcHMub25PcGVuIDogbmV4dFByb3BzLm9uQ2xvc2U7XG5cdFx0XHRoYW5kbGVyICYmIGhhbmRsZXIoKTtcblx0XHR9XG5cdH0sXG5cblx0Y29tcG9uZW50RGlkVXBkYXRlIChwcmV2UHJvcHMsIHByZXZTdGF0ZSkge1xuXHRcdC8vIGZvY3VzIHRvIHRoZSBzZWxlY3RlZCBvcHRpb25cblx0XHRpZiAodGhpcy5yZWZzLm1lbnUgJiYgdGhpcy5yZWZzLmZvY3VzZWQgJiYgdGhpcy5zdGF0ZS5pc09wZW4gJiYgIXRoaXMuaGFzU2Nyb2xsZWRUb09wdGlvbikge1xuXHRcdFx0bGV0IGZvY3VzZWRPcHRpb25Ob2RlID0gUmVhY3RET00uZmluZERPTU5vZGUodGhpcy5yZWZzLmZvY3VzZWQpO1xuXHRcdFx0bGV0IG1lbnVOb2RlID0gUmVhY3RET00uZmluZERPTU5vZGUodGhpcy5yZWZzLm1lbnUpO1xuXHRcdFx0bWVudU5vZGUuc2Nyb2xsVG9wID0gZm9jdXNlZE9wdGlvbk5vZGUub2Zmc2V0VG9wO1xuXHRcdFx0dGhpcy5oYXNTY3JvbGxlZFRvT3B0aW9uID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKCF0aGlzLnN0YXRlLmlzT3Blbikge1xuXHRcdFx0dGhpcy5oYXNTY3JvbGxlZFRvT3B0aW9uID0gZmFsc2U7XG5cdFx0fVxuXG5cdFx0aWYgKHByZXZTdGF0ZS5pbnB1dFZhbHVlICE9PSB0aGlzLnN0YXRlLmlucHV0VmFsdWUgJiYgdGhpcy5wcm9wcy5vbklucHV0Q2hhbmdlKSB7XG5cdFx0XHR0aGlzLnByb3BzLm9uSW5wdXRDaGFuZ2UodGhpcy5zdGF0ZS5pbnB1dFZhbHVlKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMuX3Njcm9sbFRvRm9jdXNlZE9wdGlvbk9uVXBkYXRlICYmIHRoaXMucmVmcy5mb2N1c2VkICYmIHRoaXMucmVmcy5tZW51KSB7XG5cdFx0XHR0aGlzLl9zY3JvbGxUb0ZvY3VzZWRPcHRpb25PblVwZGF0ZSA9IGZhbHNlO1xuXHRcdFx0dmFyIGZvY3VzZWRET00gPSBSZWFjdERPTS5maW5kRE9NTm9kZSh0aGlzLnJlZnMuZm9jdXNlZCk7XG5cdFx0XHR2YXIgbWVudURPTSA9IFJlYWN0RE9NLmZpbmRET01Ob2RlKHRoaXMucmVmcy5tZW51KTtcblx0XHRcdHZhciBmb2N1c2VkUmVjdCA9IGZvY3VzZWRET00uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG5cdFx0XHR2YXIgbWVudVJlY3QgPSBtZW51RE9NLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuXHRcdFx0aWYgKGZvY3VzZWRSZWN0LmJvdHRvbSA+IG1lbnVSZWN0LmJvdHRvbSB8fCBmb2N1c2VkUmVjdC50b3AgPCBtZW51UmVjdC50b3ApIHtcblx0XHRcdFx0bWVudURPTS5zY3JvbGxUb3AgPSAoZm9jdXNlZERPTS5vZmZzZXRUb3AgKyBmb2N1c2VkRE9NLmNsaWVudEhlaWdodCAtIG1lbnVET00ub2Zmc2V0SGVpZ2h0KTtcblx0XHRcdH1cblx0XHR9XG5cdFx0aWYgKHRoaXMucHJvcHMuc2Nyb2xsTWVudUludG9WaWV3ICYmIHRoaXMucmVmcy5tZW51Q29udGFpbmVyKSB7XG5cdFx0XHR2YXIgbWVudUNvbnRhaW5lclJlY3QgPSB0aGlzLnJlZnMubWVudUNvbnRhaW5lci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcblx0XHRcdGlmICh3aW5kb3cuaW5uZXJIZWlnaHQgPCBtZW51Q29udGFpbmVyUmVjdC5ib3R0b20gKyB0aGlzLnByb3BzLm1lbnVCdWZmZXIpIHtcblx0XHRcdFx0d2luZG93LnNjcm9sbEJ5KDAsIG1lbnVDb250YWluZXJSZWN0LmJvdHRvbSArIHRoaXMucHJvcHMubWVudUJ1ZmZlciAtIHdpbmRvdy5pbm5lckhlaWdodCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGlmIChwcmV2UHJvcHMuZGlzYWJsZWQgIT09IHRoaXMucHJvcHMuZGlzYWJsZWQpIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoeyBpc0ZvY3VzZWQ6IGZhbHNlIH0pOyAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIHJlYWN0L25vLWRpZC11cGRhdGUtc2V0LXN0YXRlXG5cdFx0fVxuXHR9LFxuXG5cdGZvY3VzICgpIHtcblx0XHRpZiAoIXRoaXMucmVmcy5pbnB1dCkgcmV0dXJuO1xuXHRcdHRoaXMucmVmcy5pbnB1dC5mb2N1cygpO1xuXG5cdFx0aWYgKHRoaXMucHJvcHMub3BlbkFmdGVyRm9jdXMpIHtcblx0XHRcdHRoaXMuc2V0U3RhdGUoe1xuXHRcdFx0XHRpc09wZW46IHRydWUsXG5cdFx0XHR9KTtcblx0XHR9XG5cdH0sXG5cblx0Ymx1cklucHV0KCkge1xuXHRcdGlmICghdGhpcy5yZWZzLmlucHV0KSByZXR1cm47XG5cdFx0dGhpcy5yZWZzLmlucHV0LmJsdXIoKTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaE1vdmUgKGV2ZW50KSB7XG5cdFx0Ly8gU2V0IGEgZmxhZyB0aGF0IHRoZSB2aWV3IGlzIGJlaW5nIGRyYWdnZWRcblx0XHR0aGlzLmRyYWdnaW5nID0gdHJ1ZTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaFN0YXJ0IChldmVudCkge1xuXHRcdC8vIFNldCBhIGZsYWcgdGhhdCB0aGUgdmlldyBpcyBub3QgYmVpbmcgZHJhZ2dlZFxuXHRcdHRoaXMuZHJhZ2dpbmcgPSBmYWxzZTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaEVuZCAoZXZlbnQpIHtcblx0XHQvLyBDaGVjayBpZiB0aGUgdmlldyBpcyBiZWluZyBkcmFnZ2VkLCBJbiB0aGlzIGNhc2Vcblx0XHQvLyB3ZSBkb24ndCB3YW50IHRvIGZpcmUgdGhlIGNsaWNrIGV2ZW50IChiZWNhdXNlIHRoZSB1c2VyIG9ubHkgd2FudHMgdG8gc2Nyb2xsKVxuXHRcdGlmKHRoaXMuZHJhZ2dpbmcpIHJldHVybjtcblxuXHRcdC8vIEZpcmUgdGhlIG1vdXNlIGV2ZW50c1xuXHRcdHRoaXMuaGFuZGxlTW91c2VEb3duKGV2ZW50KTtcblx0fSxcblxuXHRoYW5kbGVUb3VjaEVuZENsZWFyVmFsdWUgKGV2ZW50KSB7XG5cdFx0Ly8gQ2hlY2sgaWYgdGhlIHZpZXcgaXMgYmVpbmcgZHJhZ2dlZCwgSW4gdGhpcyBjYXNlXG5cdFx0Ly8gd2UgZG9uJ3Qgd2FudCB0byBmaXJlIHRoZSBjbGljayBldmVudCAoYmVjYXVzZSB0aGUgdXNlciBvbmx5IHdhbnRzIHRvIHNjcm9sbClcblx0XHRpZih0aGlzLmRyYWdnaW5nKSByZXR1cm47XG5cblx0XHQvLyBDbGVhciB0aGUgdmFsdWVcblx0XHR0aGlzLmNsZWFyVmFsdWUoZXZlbnQpO1xuXHR9LFxuXG5cdGhhbmRsZU1vdXNlRG93biAoZXZlbnQpIHtcblx0XHQvLyBpZiB0aGUgZXZlbnQgd2FzIHRyaWdnZXJlZCBieSBhIG1vdXNlZG93biBhbmQgbm90IHRoZSBwcmltYXJ5XG5cdFx0Ly8gYnV0dG9uLCBvciBpZiB0aGUgY29tcG9uZW50IGlzIGRpc2FibGVkLCBpZ25vcmUgaXQuXG5cdFx0aWYgKHRoaXMucHJvcHMuZGlzYWJsZWQgfHwgKGV2ZW50LnR5cGUgPT09ICdtb3VzZWRvd24nICYmIGV2ZW50LmJ1dHRvbiAhPT0gMCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBwcmV2ZW50IGRlZmF1bHQgZXZlbnQgaGFuZGxlcnNcblx0XHRldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcblx0XHRldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuXG5cdFx0Ly8gZm9yIHRoZSBub24tc2VhcmNoYWJsZSBzZWxlY3QsIHRvZ2dsZSB0aGUgbWVudVxuXHRcdGlmICghdGhpcy5wcm9wcy5zZWFyY2hhYmxlKSB7XG5cdFx0XHR0aGlzLmZvY3VzKCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRcdGlzT3BlbjogIXRoaXMuc3RhdGUuaXNPcGVuLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuc3RhdGUuaXNGb2N1c2VkKSB7XG5cdFx0XHQvLyBpZiB0aGUgaW5wdXQgaXMgZm9jdXNlZCwgZW5zdXJlIHRoZSBtZW51IGlzIG9wZW5cblx0XHRcdHRoaXMuc2V0U3RhdGUoe1xuXHRcdFx0XHRpc09wZW46IHRydWUsXG5cdFx0XHRcdGlzUHNldWRvRm9jdXNlZDogZmFsc2UsXG5cdFx0XHR9KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gb3RoZXJ3aXNlLCBmb2N1cyB0aGUgaW5wdXQgYW5kIG9wZW4gdGhlIG1lbnVcblx0XHRcdHRoaXMuX29wZW5BZnRlckZvY3VzID0gdHJ1ZTtcblx0XHRcdHRoaXMuZm9jdXMoKTtcblx0XHR9XG5cdH0sXG5cblx0aGFuZGxlTW91c2VEb3duT25BcnJvdyAoZXZlbnQpIHtcblx0XHQvLyBpZiB0aGUgZXZlbnQgd2FzIHRyaWdnZXJlZCBieSBhIG1vdXNlZG93biBhbmQgbm90IHRoZSBwcmltYXJ5XG5cdFx0Ly8gYnV0dG9uLCBvciBpZiB0aGUgY29tcG9uZW50IGlzIGRpc2FibGVkLCBpZ25vcmUgaXQuXG5cdFx0aWYgKHRoaXMucHJvcHMuZGlzYWJsZWQgfHwgKGV2ZW50LnR5cGUgPT09ICdtb3VzZWRvd24nICYmIGV2ZW50LmJ1dHRvbiAhPT0gMCkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Ly8gSWYgdGhlIG1lbnUgaXNuJ3Qgb3BlbiwgbGV0IHRoZSBldmVudCBidWJibGUgdG8gdGhlIG1haW4gaGFuZGxlTW91c2VEb3duXG5cdFx0aWYgKCF0aGlzLnN0YXRlLmlzT3Blbikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHQvLyBwcmV2ZW50IGRlZmF1bHQgZXZlbnQgaGFuZGxlcnNcblx0XHRldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcblx0XHRldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuXHRcdC8vIGNsb3NlIHRoZSBtZW51XG5cdFx0dGhpcy5jbG9zZU1lbnUoKTtcblx0fSxcblxuXHRoYW5kbGVNb3VzZURvd25Pbk1lbnUgKGV2ZW50KSB7XG5cdFx0Ly8gaWYgdGhlIGV2ZW50IHdhcyB0cmlnZ2VyZWQgYnkgYSBtb3VzZWRvd24gYW5kIG5vdCB0aGUgcHJpbWFyeVxuXHRcdC8vIGJ1dHRvbiwgb3IgaWYgdGhlIGNvbXBvbmVudCBpcyBkaXNhYmxlZCwgaWdub3JlIGl0LlxuXHRcdGlmICh0aGlzLnByb3BzLmRpc2FibGVkIHx8IChldmVudC50eXBlID09PSAnbW91c2Vkb3duJyAmJiBldmVudC5idXR0b24gIT09IDApKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuXHRcdGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG5cblx0XHR0aGlzLl9vcGVuQWZ0ZXJGb2N1cyA9IHRydWU7XG5cdFx0dGhpcy5mb2N1cygpO1xuXHR9LFxuXG5cdGNsb3NlTWVudSAoKSB7XG5cdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRpc09wZW46IGZhbHNlLFxuXHRcdFx0aXNQc2V1ZG9Gb2N1c2VkOiB0aGlzLnN0YXRlLmlzRm9jdXNlZCAmJiAhdGhpcy5wcm9wcy5tdWx0aSxcblx0XHRcdGlucHV0VmFsdWU6ICcnLFxuXHRcdH0pO1xuXHRcdHRoaXMuaGFzU2Nyb2xsZWRUb09wdGlvbiA9IGZhbHNlO1xuXHR9LFxuXG5cdGhhbmRsZUlucHV0Rm9jdXMgKGV2ZW50KSB7XG5cdFx0dmFyIGlzT3BlbiA9IHRoaXMuc3RhdGUuaXNPcGVuIHx8IHRoaXMuX29wZW5BZnRlckZvY3VzIHx8IHRoaXMucHJvcHMub3Blbk9uRm9jdXM7XG5cdFx0aWYgKHRoaXMucHJvcHMub25Gb2N1cykge1xuXHRcdFx0dGhpcy5wcm9wcy5vbkZvY3VzKGV2ZW50KTtcblx0XHR9XG5cdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRpc0ZvY3VzZWQ6IHRydWUsXG5cdFx0XHRpc09wZW46IGlzT3BlblxuXHRcdH0pO1xuXHRcdHRoaXMuX29wZW5BZnRlckZvY3VzID0gZmFsc2U7XG5cdH0sXG5cblx0aGFuZGxlSW5wdXRCbHVyIChldmVudCkge1xuXHRcdGlmICh0aGlzLnJlZnMubWVudSAmJiBkb2N1bWVudC5hY3RpdmVFbGVtZW50LmlzRXF1YWxOb2RlKHRoaXMucmVmcy5tZW51KSkge1xuXHRcdFx0dGhpcy5mb2N1cygpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmICh0aGlzLnByb3BzLm9uQmx1cikge1xuXHRcdFx0dGhpcy5wcm9wcy5vbkJsdXIoZXZlbnQpO1xuXHRcdH1cblx0XHR2YXIgb25CbHVycmVkU3RhdGUgPSB7XG5cdFx0XHRpc0ZvY3VzZWQ6IGZhbHNlLFxuXHRcdFx0aXNPcGVuOiBmYWxzZSxcblx0XHRcdGlzUHNldWRvRm9jdXNlZDogZmFsc2UsXG5cdFx0fTtcblx0XHRpZiAodGhpcy5wcm9wcy5vbkJsdXJSZXNldHNJbnB1dCkge1xuXHRcdFx0b25CbHVycmVkU3RhdGUuaW5wdXRWYWx1ZSA9ICcnO1xuXHRcdH1cblx0XHR0aGlzLnNldFN0YXRlKG9uQmx1cnJlZFN0YXRlKTtcblx0fSxcblxuXHRoYW5kbGVJbnB1dENoYW5nZSAoZXZlbnQpIHtcblx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdGlzT3BlbjogdHJ1ZSxcblx0XHRcdGlzUHNldWRvRm9jdXNlZDogZmFsc2UsXG5cdFx0XHRpbnB1dFZhbHVlOiBldmVudC50YXJnZXQudmFsdWUsXG5cdFx0fSk7XG5cdH0sXG5cblx0aGFuZGxlS2V5RG93biAoZXZlbnQpIHtcblx0XHRpZiAodGhpcy5wcm9wcy5kaXNhYmxlZCkgcmV0dXJuO1xuXHRcdHN3aXRjaCAoZXZlbnQua2V5Q29kZSkge1xuXHRcdFx0Y2FzZSA4OiAvLyBiYWNrc3BhY2Vcblx0XHRcdFx0aWYgKCF0aGlzLnN0YXRlLmlucHV0VmFsdWUgJiYgdGhpcy5wcm9wcy5iYWNrc3BhY2VSZW1vdmVzKSB7XG5cdFx0XHRcdFx0ZXZlbnQucHJldmVudERlZmF1bHQoKTtcblx0XHRcdFx0XHR0aGlzLnBvcFZhbHVlKCk7XG5cdFx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHRcdGNhc2UgOTogLy8gdGFiXG5cdFx0XHRcdGlmIChldmVudC5zaGlmdEtleSB8fCAhdGhpcy5zdGF0ZS5pc09wZW4gfHwgIXRoaXMucHJvcHMudGFiU2VsZWN0c1ZhbHVlKSB7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRoaXMuc2VsZWN0Rm9jdXNlZE9wdGlvbigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdFx0Y2FzZSAxMzogLy8gZW50ZXJcblx0XHRcdFx0aWYgKCF0aGlzLnN0YXRlLmlzT3BlbikgcmV0dXJuO1xuXHRcdFx0XHRldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcblx0XHRcdFx0dGhpcy5zZWxlY3RGb2N1c2VkT3B0aW9uKCk7XG5cdFx0XHRicmVhaztcblx0XHRcdGNhc2UgMjc6IC8vIGVzY2FwZVxuXHRcdFx0XHRpZiAodGhpcy5zdGF0ZS5pc09wZW4pIHtcblx0XHRcdFx0XHR0aGlzLmNsb3NlTWVudSgpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHRoaXMucHJvcHMuY2xlYXJhYmxlICYmIHRoaXMucHJvcHMuZXNjYXBlQ2xlYXJzVmFsdWUpIHtcblx0XHRcdFx0XHR0aGlzLmNsZWFyVmFsdWUoZXZlbnQpO1xuXHRcdFx0XHR9XG5cdFx0XHRicmVhaztcblx0XHRcdGNhc2UgMzg6IC8vIHVwXG5cdFx0XHRcdHRoaXMuZm9jdXNQcmV2aW91c09wdGlvbigpO1xuXHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIDQwOiAvLyBkb3duXG5cdFx0XHRcdHRoaXMuZm9jdXNOZXh0T3B0aW9uKCk7XG5cdFx0XHRicmVhaztcblx0XHRcdC8vIGNhc2UgMTg4OiAvLyAsXG5cdFx0XHQvLyBcdGlmICh0aGlzLnByb3BzLmFsbG93Q3JlYXRlICYmIHRoaXMucHJvcHMubXVsdGkpIHtcblx0XHRcdC8vIFx0XHRldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuXHRcdFx0Ly8gXHRcdGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuXHRcdFx0Ly8gXHRcdHRoaXMuc2VsZWN0Rm9jdXNlZE9wdGlvbigpO1xuXHRcdFx0Ly8gXHR9IGVsc2Uge1xuXHRcdFx0Ly8gXHRcdHJldHVybjtcblx0XHRcdC8vIFx0fVxuXHRcdFx0Ly8gYnJlYWs7XG5cdFx0XHRkZWZhdWx0OiByZXR1cm47XG5cdFx0fVxuXHRcdGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG5cdH0sXG5cblx0aGFuZGxlVmFsdWVDbGljayAob3B0aW9uLCBldmVudCkge1xuXHRcdGlmICghdGhpcy5wcm9wcy5vblZhbHVlQ2xpY2spIHJldHVybjtcblx0XHR0aGlzLnByb3BzLm9uVmFsdWVDbGljayhvcHRpb24sIGV2ZW50KTtcblx0fSxcblxuXHRoYW5kbGVNZW51U2Nyb2xsIChldmVudCkge1xuXHRcdGlmICghdGhpcy5wcm9wcy5vbk1lbnVTY3JvbGxUb0JvdHRvbSkgcmV0dXJuO1xuXHRcdGxldCB7IHRhcmdldCB9ID0gZXZlbnQ7XG5cdFx0aWYgKHRhcmdldC5zY3JvbGxIZWlnaHQgPiB0YXJnZXQub2Zmc2V0SGVpZ2h0ICYmICEodGFyZ2V0LnNjcm9sbEhlaWdodCAtIHRhcmdldC5vZmZzZXRIZWlnaHQgLSB0YXJnZXQuc2Nyb2xsVG9wKSkge1xuXHRcdFx0dGhpcy5wcm9wcy5vbk1lbnVTY3JvbGxUb0JvdHRvbSgpO1xuXHRcdH1cblx0fSxcblxuXHRoYW5kbGVSZXF1aXJlZCAodmFsdWUsIG11bHRpKSB7XG5cdFx0aWYgKCF2YWx1ZSkgcmV0dXJuIHRydWU7XG5cdFx0cmV0dXJuIChtdWx0aSA/IHZhbHVlLmxlbmd0aCA9PT0gMCA6IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGggPT09IDApO1xuXHR9LFxuXG5cdGdldE9wdGlvbkxhYmVsIChvcCkge1xuXHRcdHJldHVybiBvcFt0aGlzLnByb3BzLmxhYmVsS2V5XTtcblx0fSxcblxuXHRnZXRWYWx1ZUFycmF5ICgpIHtcblx0XHRsZXQgdmFsdWUgPSB0aGlzLnByb3BzLnZhbHVlO1xuXHRcdGlmICh0aGlzLnByb3BzLm11bHRpKSB7XG5cdFx0XHRpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgdmFsdWUgPSB2YWx1ZS5zcGxpdCh0aGlzLnByb3BzLmRlbGltaXRlcik7XG5cdFx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG5cdFx0XHRcdGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gW107XG5cdFx0XHRcdHZhbHVlID0gW3ZhbHVlXTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB2YWx1ZS5tYXAodGhpcy5leHBhbmRWYWx1ZSkuZmlsdGVyKGkgPT4gaSk7XG5cdFx0fVxuXHRcdHZhciBleHBhbmRlZFZhbHVlID0gdGhpcy5leHBhbmRWYWx1ZSh2YWx1ZSk7XG5cdFx0cmV0dXJuIGV4cGFuZGVkVmFsdWUgPyBbZXhwYW5kZWRWYWx1ZV0gOiBbXTtcblx0fSxcblxuXHRleHBhbmRWYWx1ZSAodmFsdWUpIHtcblx0XHRpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyAmJiB0eXBlb2YgdmFsdWUgIT09ICdudW1iZXInKSByZXR1cm4gdmFsdWU7XG5cdFx0bGV0IHsgb3B0aW9ucywgdmFsdWVLZXkgfSA9IHRoaXMucHJvcHM7XG5cdFx0aWYgKCFvcHRpb25zKSByZXR1cm47XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBvcHRpb25zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRpZiAob3B0aW9uc1tpXVt2YWx1ZUtleV0gPT09IHZhbHVlKSByZXR1cm4gb3B0aW9uc1tpXTtcblx0XHR9XG5cdH0sXG5cblx0c2V0VmFsdWUgKHZhbHVlKSB7XG5cdFx0aWYgKHRoaXMucHJvcHMuYXV0b0JsdXIpe1xuXHRcdFx0dGhpcy5ibHVySW5wdXQoKTtcblx0XHR9XG5cdFx0aWYgKCF0aGlzLnByb3BzLm9uQ2hhbmdlKSByZXR1cm47XG5cdFx0aWYgKHRoaXMucHJvcHMucmVxdWlyZWQpIHtcblx0XHRcdGNvbnN0IHJlcXVpcmVkID0gdGhpcy5oYW5kbGVSZXF1aXJlZCh2YWx1ZSwgdGhpcy5wcm9wcy5tdWx0aSk7XG5cdFx0XHR0aGlzLnNldFN0YXRlKHsgcmVxdWlyZWQgfSk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLnByb3BzLnNpbXBsZVZhbHVlICYmIHZhbHVlKSB7XG5cdFx0XHR2YWx1ZSA9IHRoaXMucHJvcHMubXVsdGkgPyB2YWx1ZS5tYXAoaSA9PiBpW3RoaXMucHJvcHMudmFsdWVLZXldKS5qb2luKHRoaXMucHJvcHMuZGVsaW1pdGVyKSA6IHZhbHVlW3RoaXMucHJvcHMudmFsdWVLZXldO1xuXHRcdH1cblx0XHR0aGlzLnByb3BzLm9uQ2hhbmdlKHZhbHVlKTtcblx0fSxcblxuXHRzZWxlY3RWYWx1ZSAodmFsdWUpIHtcblx0XHR0aGlzLmhhc1Njcm9sbGVkVG9PcHRpb24gPSBmYWxzZTtcblx0XHRpZiAodGhpcy5wcm9wcy5tdWx0aSkge1xuXHRcdFx0dGhpcy5hZGRWYWx1ZSh2YWx1ZSk7XG5cdFx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdFx0aW5wdXRWYWx1ZTogJycsXG5cdFx0XHR9KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXRWYWx1ZSh2YWx1ZSk7XG5cdFx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdFx0aXNPcGVuOiBmYWxzZSxcblx0XHRcdFx0aW5wdXRWYWx1ZTogJycsXG5cdFx0XHRcdGlzUHNldWRvRm9jdXNlZDogdGhpcy5zdGF0ZS5pc0ZvY3VzZWQsXG5cdFx0XHR9KTtcblx0XHR9XG5cdH0sXG5cblx0YWRkVmFsdWUgKHZhbHVlKSB7XG5cdFx0dmFyIHZhbHVlQXJyYXkgPSB0aGlzLmdldFZhbHVlQXJyYXkoKTtcblx0XHR0aGlzLnNldFZhbHVlKHZhbHVlQXJyYXkuY29uY2F0KHZhbHVlKSk7XG5cdH0sXG5cblx0cG9wVmFsdWUgKCkge1xuXHRcdHZhciB2YWx1ZUFycmF5ID0gdGhpcy5nZXRWYWx1ZUFycmF5KCk7XG5cdFx0aWYgKCF2YWx1ZUFycmF5Lmxlbmd0aCkgcmV0dXJuO1xuXHRcdGlmICh2YWx1ZUFycmF5W3ZhbHVlQXJyYXkubGVuZ3RoLTFdLmNsZWFyYWJsZVZhbHVlID09PSBmYWxzZSkgcmV0dXJuO1xuXHRcdHRoaXMuc2V0VmFsdWUodmFsdWVBcnJheS5zbGljZSgwLCB2YWx1ZUFycmF5Lmxlbmd0aCAtIDEpKTtcblx0fSxcblxuXHRyZW1vdmVWYWx1ZSAodmFsdWUpIHtcblx0XHR2YXIgdmFsdWVBcnJheSA9IHRoaXMuZ2V0VmFsdWVBcnJheSgpO1xuXHRcdHRoaXMuc2V0VmFsdWUodmFsdWVBcnJheS5maWx0ZXIoaSA9PiBpICE9PSB2YWx1ZSkpO1xuXHRcdHRoaXMuZm9jdXMoKTtcblx0fSxcblxuXHRjbGVhclZhbHVlIChldmVudCkge1xuXHRcdC8vIGlmIHRoZSBldmVudCB3YXMgdHJpZ2dlcmVkIGJ5IGEgbW91c2Vkb3duIGFuZCBub3QgdGhlIHByaW1hcnlcblx0XHQvLyBidXR0b24sIGlnbm9yZSBpdC5cblx0XHRpZiAoZXZlbnQgJiYgZXZlbnQudHlwZSA9PT0gJ21vdXNlZG93bicgJiYgZXZlbnQuYnV0dG9uICE9PSAwKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuXHRcdGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG5cdFx0dGhpcy5zZXRWYWx1ZShudWxsKTtcblx0XHR0aGlzLnNldFN0YXRlKHtcblx0XHRcdGlzT3BlbjogZmFsc2UsXG5cdFx0XHRpbnB1dFZhbHVlOiAnJyxcblx0XHR9LCB0aGlzLmZvY3VzKTtcblx0fSxcblxuXHRmb2N1c09wdGlvbiAob3B0aW9uKSB7XG5cdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRmb2N1c2VkT3B0aW9uOiBvcHRpb25cblx0XHR9KTtcblx0fSxcblxuXHRmb2N1c05leHRPcHRpb24gKCkge1xuXHRcdHRoaXMuZm9jdXNBZGphY2VudE9wdGlvbignbmV4dCcpO1xuXHR9LFxuXG5cdGZvY3VzUHJldmlvdXNPcHRpb24gKCkge1xuXHRcdHRoaXMuZm9jdXNBZGphY2VudE9wdGlvbigncHJldmlvdXMnKTtcblx0fSxcblxuXHRmb2N1c0FkamFjZW50T3B0aW9uIChkaXIpIHtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMuX3Zpc2libGVPcHRpb25zLmZpbHRlcihpID0+ICFpLmRpc2FibGVkKTtcblx0XHR0aGlzLl9zY3JvbGxUb0ZvY3VzZWRPcHRpb25PblVwZGF0ZSA9IHRydWU7XG5cdFx0aWYgKCF0aGlzLnN0YXRlLmlzT3Blbikge1xuXHRcdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRcdGlzT3BlbjogdHJ1ZSxcblx0XHRcdFx0aW5wdXRWYWx1ZTogJycsXG5cdFx0XHRcdGZvY3VzZWRPcHRpb246IHRoaXMuX2ZvY3VzZWRPcHRpb24gfHwgb3B0aW9uc1tkaXIgPT09ICduZXh0JyA/IDAgOiBvcHRpb25zLmxlbmd0aCAtIDFdXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKCFvcHRpb25zLmxlbmd0aCkgcmV0dXJuO1xuXHRcdHZhciBmb2N1c2VkSW5kZXggPSAtMTtcblx0XHRmb3IgKHZhciBpID0gMDsgaSA8IG9wdGlvbnMubGVuZ3RoOyBpKyspIHtcblx0XHRcdGlmICh0aGlzLl9mb2N1c2VkT3B0aW9uID09PSBvcHRpb25zW2ldKSB7XG5cdFx0XHRcdGZvY3VzZWRJbmRleCA9IGk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblx0XHR2YXIgZm9jdXNlZE9wdGlvbiA9IG9wdGlvbnNbMF07XG5cdFx0aWYgKGRpciA9PT0gJ25leHQnICYmIGZvY3VzZWRJbmRleCA+IC0xICYmIGZvY3VzZWRJbmRleCA8IG9wdGlvbnMubGVuZ3RoIC0gMSkge1xuXHRcdFx0Zm9jdXNlZE9wdGlvbiA9IG9wdGlvbnNbZm9jdXNlZEluZGV4ICsgMV07XG5cdFx0fSBlbHNlIGlmIChkaXIgPT09ICdwcmV2aW91cycpIHtcblx0XHRcdGlmIChmb2N1c2VkSW5kZXggPiAwKSB7XG5cdFx0XHRcdGZvY3VzZWRPcHRpb24gPSBvcHRpb25zW2ZvY3VzZWRJbmRleCAtIDFdO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Zm9jdXNlZE9wdGlvbiA9IG9wdGlvbnNbb3B0aW9ucy5sZW5ndGggLSAxXTtcblx0XHRcdH1cblx0XHR9XG5cdFx0dGhpcy5zZXRTdGF0ZSh7XG5cdFx0XHRmb2N1c2VkT3B0aW9uOiBmb2N1c2VkT3B0aW9uXG5cdFx0fSk7XG5cdH0sXG5cblx0c2VsZWN0Rm9jdXNlZE9wdGlvbiAoKSB7XG5cdFx0Ly8gaWYgKHRoaXMucHJvcHMuYWxsb3dDcmVhdGUgJiYgIXRoaXMuc3RhdGUuZm9jdXNlZE9wdGlvbikge1xuXHRcdC8vIFx0cmV0dXJuIHRoaXMuc2VsZWN0VmFsdWUodGhpcy5zdGF0ZS5pbnB1dFZhbHVlKTtcblx0XHQvLyB9XG5cdFx0aWYgKHRoaXMuX2ZvY3VzZWRPcHRpb24pIHtcblx0XHRcdHJldHVybiB0aGlzLnNlbGVjdFZhbHVlKHRoaXMuX2ZvY3VzZWRPcHRpb24pO1xuXHRcdH1cblx0fSxcblxuXHRyZW5kZXJMb2FkaW5nICgpIHtcblx0XHRpZiAoIXRoaXMucHJvcHMuaXNMb2FkaW5nKSByZXR1cm47XG5cdFx0cmV0dXJuIChcblx0XHRcdDxzcGFuIGNsYXNzTmFtZT1cIlNlbGVjdC1sb2FkaW5nLXpvbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5cblx0XHRcdFx0PHNwYW4gY2xhc3NOYW1lPVwiU2VsZWN0LWxvYWRpbmdcIiAvPlxuXHRcdFx0PC9zcGFuPlxuXHRcdCk7XG5cdH0sXG5cblx0cmVuZGVyVmFsdWUgKHZhbHVlQXJyYXksIGlzT3Blbikge1xuXHRcdGxldCByZW5kZXJMYWJlbCA9IHRoaXMucHJvcHMudmFsdWVSZW5kZXJlciB8fCB0aGlzLmdldE9wdGlvbkxhYmVsO1xuXHRcdGxldCBWYWx1ZUNvbXBvbmVudCA9IHRoaXMucHJvcHMudmFsdWVDb21wb25lbnQ7XG5cdFx0aWYgKCF2YWx1ZUFycmF5Lmxlbmd0aCkge1xuXHRcdFx0cmV0dXJuICF0aGlzLnN0YXRlLmlucHV0VmFsdWUgPyA8ZGl2IGNsYXNzTmFtZT1cIlNlbGVjdC1wbGFjZWhvbGRlclwiPnt0aGlzLnByb3BzLnBsYWNlaG9sZGVyfTwvZGl2PiA6IG51bGw7XG5cdFx0fVxuXHRcdGxldCBvbkNsaWNrID0gdGhpcy5wcm9wcy5vblZhbHVlQ2xpY2sgPyB0aGlzLmhhbmRsZVZhbHVlQ2xpY2sgOiBudWxsO1xuXHRcdGlmICh0aGlzLnByb3BzLm11bHRpKSB7XG5cdFx0XHRyZXR1cm4gdmFsdWVBcnJheS5tYXAoKHZhbHVlLCBpKSA9PiB7XG5cdFx0XHRcdHJldHVybiAoXG5cdFx0XHRcdFx0PFZhbHVlQ29tcG9uZW50XG4gICAgICAgICAgICBtb3ZlSXRlbT17dGhpcy5wcm9wcy5tb3ZlSXRlbX1cblx0XHRcdFx0XHRcdGRpc2FibGVkPXt0aGlzLnByb3BzLmRpc2FibGVkIHx8IHZhbHVlLmNsZWFyYWJsZVZhbHVlID09PSBmYWxzZX1cblx0XHRcdFx0XHRcdGtleT17YHZhbHVlLSR7dmFsdWVbdGhpcy5wcm9wcy52YWx1ZUtleV19YH1cblx0XHRcdFx0XHRcdG9uQ2xpY2s9e29uQ2xpY2t9XG5cdFx0XHRcdFx0XHRvblJlbW92ZT17dGhpcy5yZW1vdmVWYWx1ZX1cblx0XHRcdFx0XHRcdHZhbHVlPXt2YWx1ZX1cblx0XHRcdFx0XHRcdD5cblx0XHRcdFx0XHRcdHtyZW5kZXJMYWJlbCh2YWx1ZSl9XG5cdFx0XHRcdFx0PC9WYWx1ZUNvbXBvbmVudD5cblx0XHRcdFx0KTtcblx0XHRcdH0pO1xuXHRcdH0gZWxzZSBpZiAoIXRoaXMuc3RhdGUuaW5wdXRWYWx1ZSkge1xuXHRcdFx0aWYgKGlzT3Blbikgb25DbGljayA9IG51bGw7XG5cdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHQ8VmFsdWVDb21wb25lbnRcblx0XHRcdFx0XHRkaXNhYmxlZD17dGhpcy5wcm9wcy5kaXNhYmxlZH1cblx0XHRcdFx0XHRvbkNsaWNrPXtvbkNsaWNrfVxuXHRcdFx0XHRcdHZhbHVlPXt2YWx1ZUFycmF5WzBdfVxuXHRcdFx0XHRcdD5cblx0XHRcdFx0XHR7cmVuZGVyTGFiZWwodmFsdWVBcnJheVswXSl9XG5cdFx0XHRcdDwvVmFsdWVDb21wb25lbnQ+XG5cdFx0XHQpO1xuXHRcdH1cblx0fSxcblxuXHRyZW5kZXJJbnB1dCAodmFsdWVBcnJheSkge1xuXHRcdHZhciBjbGFzc05hbWUgPSBjbGFzc05hbWVzKCdTZWxlY3QtaW5wdXQnLCB0aGlzLnByb3BzLmlucHV0UHJvcHMuY2xhc3NOYW1lKTtcblx0XHRpZiAodGhpcy5wcm9wcy5kaXNhYmxlZCB8fCAhdGhpcy5wcm9wcy5zZWFyY2hhYmxlKSB7XG5cdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHQ8ZGl2XG5cdFx0XHRcdFx0ey4uLnRoaXMucHJvcHMuaW5wdXRQcm9wc31cblx0XHRcdFx0XHRjbGFzc05hbWU9e2NsYXNzTmFtZX1cblx0XHRcdFx0XHR0YWJJbmRleD17dGhpcy5wcm9wcy50YWJJbmRleCB8fCAwfVxuXHRcdFx0XHRcdG9uQmx1cj17dGhpcy5oYW5kbGVJbnB1dEJsdXJ9XG5cdFx0XHRcdFx0b25Gb2N1cz17dGhpcy5oYW5kbGVJbnB1dEZvY3VzfVxuXHRcdFx0XHRcdHJlZj1cImlucHV0XCJcblx0XHRcdFx0XHRzdHlsZT17eyBib3JkZXI6IDAsIHdpZHRoOiAxLCBkaXNwbGF5OidpbmxpbmUtYmxvY2snIH19Lz5cblx0XHRcdCk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLnByb3BzLmF1dG9zaXplKSB7XG5cdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHQ8SW5wdXRcblx0XHRcdFx0XHR7Li4udGhpcy5wcm9wcy5pbnB1dFByb3BzfVxuXHRcdFx0XHRcdGNsYXNzTmFtZT17Y2xhc3NOYW1lfVxuXHRcdFx0XHRcdHRhYkluZGV4PXt0aGlzLnByb3BzLnRhYkluZGV4fVxuXHRcdFx0XHRcdG9uQmx1cj17dGhpcy5oYW5kbGVJbnB1dEJsdXJ9XG5cdFx0XHRcdFx0b25DaGFuZ2U9e3RoaXMuaGFuZGxlSW5wdXRDaGFuZ2V9XG5cdFx0XHRcdFx0b25Gb2N1cz17dGhpcy5oYW5kbGVJbnB1dEZvY3VzfVxuXHRcdFx0XHRcdG1pbldpZHRoPVwiNVwiXG5cdFx0XHRcdFx0cmVmPVwiaW5wdXRcIlxuXHRcdFx0XHRcdHJlcXVpcmVkPXt0aGlzLnN0YXRlLnJlcXVpcmVkfVxuXHRcdFx0XHRcdHZhbHVlPXt0aGlzLnN0YXRlLmlucHV0VmFsdWV9XG5cdFx0XHRcdC8+XG5cdFx0XHQpO1xuXHRcdH1cblx0XHRyZXR1cm4gKFxuXHRcdFx0PGRpdiBjbGFzc05hbWU9eyBjbGFzc05hbWUgfT5cblx0XHRcdFx0PGlucHV0XG5cdFx0XHRcdFx0ey4uLnRoaXMucHJvcHMuaW5wdXRQcm9wc31cblx0XHRcdFx0XHR0YWJJbmRleD17dGhpcy5wcm9wcy50YWJJbmRleH1cblx0XHRcdFx0XHRvbkJsdXI9e3RoaXMuaGFuZGxlSW5wdXRCbHVyfVxuXHRcdFx0XHRcdG9uQ2hhbmdlPXt0aGlzLmhhbmRsZUlucHV0Q2hhbmdlfVxuXHRcdFx0XHRcdG9uRm9jdXM9e3RoaXMuaGFuZGxlSW5wdXRGb2N1c31cblx0XHRcdFx0XHRyZWY9XCJpbnB1dFwiXG5cdFx0XHRcdFx0cmVxdWlyZWQ9e3RoaXMuc3RhdGUucmVxdWlyZWR9XG5cdFx0XHRcdFx0dmFsdWU9e3RoaXMuc3RhdGUuaW5wdXRWYWx1ZX1cblx0XHRcdFx0Lz5cblx0XHRcdDwvZGl2PlxuXHRcdCk7XG5cdH0sXG5cblx0cmVuZGVyQ2xlYXIgKCkge1xuXHRcdGlmICghdGhpcy5wcm9wcy5jbGVhcmFibGUgfHwgIXRoaXMucHJvcHMudmFsdWUgfHwgKHRoaXMucHJvcHMubXVsdGkgJiYgIXRoaXMucHJvcHMudmFsdWUubGVuZ3RoKSB8fCB0aGlzLnByb3BzLmRpc2FibGVkIHx8IHRoaXMucHJvcHMuaXNMb2FkaW5nKSByZXR1cm47XG5cdFx0cmV0dXJuIChcblx0XHRcdDxzcGFuIGNsYXNzTmFtZT1cIlNlbGVjdC1jbGVhci16b25lXCIgdGl0bGU9e3RoaXMucHJvcHMubXVsdGkgPyB0aGlzLnByb3BzLmNsZWFyQWxsVGV4dCA6IHRoaXMucHJvcHMuY2xlYXJWYWx1ZVRleHR9XG5cdFx0XHRcdFx0XHRhcmlhLWxhYmVsPXt0aGlzLnByb3BzLm11bHRpID8gdGhpcy5wcm9wcy5jbGVhckFsbFRleHQgOiB0aGlzLnByb3BzLmNsZWFyVmFsdWVUZXh0fVxuXHRcdFx0XHRcdFx0b25Nb3VzZURvd249e3RoaXMuY2xlYXJWYWx1ZX1cblx0XHRcdFx0XHRcdG9uVG91Y2hTdGFydD17dGhpcy5oYW5kbGVUb3VjaFN0YXJ0fVxuXHRcdFx0XHRcdFx0b25Ub3VjaE1vdmU9e3RoaXMuaGFuZGxlVG91Y2hNb3ZlfVxuXHRcdFx0XHRcdFx0b25Ub3VjaEVuZD17dGhpcy5oYW5kbGVUb3VjaEVuZENsZWFyVmFsdWV9PlxuXHRcdFx0XHQ8c3BhbiBjbGFzc05hbWU9XCJTZWxlY3QtY2xlYXJcIiBkYW5nZXJvdXNseVNldElubmVySFRNTD17eyBfX2h0bWw6ICcmdGltZXM7JyB9fSAvPlxuXHRcdFx0PC9zcGFuPlxuXHRcdCk7XG5cdH0sXG5cblx0cmVuZGVyQXJyb3cgKCkge1xuXHRcdHJldHVybiAoXG5cdFx0XHQ8c3BhbiBjbGFzc05hbWU9XCJTZWxlY3QtYXJyb3ctem9uZVwiIG9uTW91c2VEb3duPXt0aGlzLmhhbmRsZU1vdXNlRG93bk9uQXJyb3d9PlxuXHRcdFx0XHQ8c3BhbiBjbGFzc05hbWU9XCJTZWxlY3QtYXJyb3dcIiBvbk1vdXNlRG93bj17dGhpcy5oYW5kbGVNb3VzZURvd25PbkFycm93fSAvPlxuXHRcdFx0PC9zcGFuPlxuXHRcdCk7XG5cdH0sXG5cblx0ZmlsdGVyT3B0aW9ucyAoZXhjbHVkZU9wdGlvbnMpIHtcblx0XHR2YXIgZmlsdGVyVmFsdWUgPSB0aGlzLnN0YXRlLmlucHV0VmFsdWU7XG5cdFx0dmFyIG9wdGlvbnMgPSB0aGlzLnByb3BzLm9wdGlvbnMgfHwgW107XG5cdFx0aWYgKHR5cGVvZiB0aGlzLnByb3BzLmZpbHRlck9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcblx0XHRcdHJldHVybiB0aGlzLnByb3BzLmZpbHRlck9wdGlvbnMuY2FsbCh0aGlzLCBvcHRpb25zLCBmaWx0ZXJWYWx1ZSwgZXhjbHVkZU9wdGlvbnMpO1xuXHRcdH0gZWxzZSBpZiAodGhpcy5wcm9wcy5maWx0ZXJPcHRpb25zKSB7XG5cdFx0XHRpZiAodGhpcy5wcm9wcy5pZ25vcmVBY2NlbnRzKSB7XG5cdFx0XHRcdGZpbHRlclZhbHVlID0gc3RyaXBEaWFjcml0aWNzKGZpbHRlclZhbHVlKTtcblx0XHRcdH1cblx0XHRcdGlmICh0aGlzLnByb3BzLmlnbm9yZUNhc2UpIHtcblx0XHRcdFx0ZmlsdGVyVmFsdWUgPSBmaWx0ZXJWYWx1ZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGV4Y2x1ZGVPcHRpb25zKSBleGNsdWRlT3B0aW9ucyA9IGV4Y2x1ZGVPcHRpb25zLm1hcChpID0+IGlbdGhpcy5wcm9wcy52YWx1ZUtleV0pO1xuXHRcdFx0cmV0dXJuIG9wdGlvbnMuZmlsdGVyKG9wdGlvbiA9PiB7XG5cdFx0XHRcdGlmIChleGNsdWRlT3B0aW9ucyAmJiBleGNsdWRlT3B0aW9ucy5pbmRleE9mKG9wdGlvblt0aGlzLnByb3BzLnZhbHVlS2V5XSkgPiAtMSkgcmV0dXJuIGZhbHNlO1xuXHRcdFx0XHRpZiAodGhpcy5wcm9wcy5maWx0ZXJPcHRpb24pIHJldHVybiB0aGlzLnByb3BzLmZpbHRlck9wdGlvbi5jYWxsKHRoaXMsIG9wdGlvbiwgZmlsdGVyVmFsdWUpO1xuXHRcdFx0XHRpZiAoIWZpbHRlclZhbHVlKSByZXR1cm4gdHJ1ZTtcblx0XHRcdFx0dmFyIHZhbHVlVGVzdCA9IFN0cmluZyhvcHRpb25bdGhpcy5wcm9wcy52YWx1ZUtleV0pO1xuXHRcdFx0XHR2YXIgbGFiZWxUZXN0ID0gU3RyaW5nKG9wdGlvblt0aGlzLnByb3BzLmxhYmVsS2V5XSk7XG5cdFx0XHRcdGlmICh0aGlzLnByb3BzLmlnbm9yZUFjY2VudHMpIHtcblx0XHRcdFx0XHRpZiAodGhpcy5wcm9wcy5tYXRjaFByb3AgIT09ICdsYWJlbCcpIHZhbHVlVGVzdCA9IHN0cmlwRGlhY3JpdGljcyh2YWx1ZVRlc3QpO1xuXHRcdFx0XHRcdGlmICh0aGlzLnByb3BzLm1hdGNoUHJvcCAhPT0gJ3ZhbHVlJykgbGFiZWxUZXN0ID0gc3RyaXBEaWFjcml0aWNzKGxhYmVsVGVzdCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKHRoaXMucHJvcHMuaWdub3JlQ2FzZSkge1xuXHRcdFx0XHRcdGlmICh0aGlzLnByb3BzLm1hdGNoUHJvcCAhPT0gJ2xhYmVsJykgdmFsdWVUZXN0ID0gdmFsdWVUZXN0LnRvTG93ZXJDYXNlKCk7XG5cdFx0XHRcdFx0aWYgKHRoaXMucHJvcHMubWF0Y2hQcm9wICE9PSAndmFsdWUnKSBsYWJlbFRlc3QgPSBsYWJlbFRlc3QudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gdGhpcy5wcm9wcy5tYXRjaFBvcyA9PT0gJ3N0YXJ0JyA/IChcblx0XHRcdFx0XHQodGhpcy5wcm9wcy5tYXRjaFByb3AgIT09ICdsYWJlbCcgJiYgdmFsdWVUZXN0LnN1YnN0cigwLCBmaWx0ZXJWYWx1ZS5sZW5ndGgpID09PSBmaWx0ZXJWYWx1ZSkgfHxcblx0XHRcdFx0XHQodGhpcy5wcm9wcy5tYXRjaFByb3AgIT09ICd2YWx1ZScgJiYgbGFiZWxUZXN0LnN1YnN0cigwLCBmaWx0ZXJWYWx1ZS5sZW5ndGgpID09PSBmaWx0ZXJWYWx1ZSlcblx0XHRcdFx0KSA6IChcblx0XHRcdFx0XHQodGhpcy5wcm9wcy5tYXRjaFByb3AgIT09ICdsYWJlbCcgJiYgdmFsdWVUZXN0LmluZGV4T2YoZmlsdGVyVmFsdWUpID49IDApIHx8XG5cdFx0XHRcdFx0KHRoaXMucHJvcHMubWF0Y2hQcm9wICE9PSAndmFsdWUnICYmIGxhYmVsVGVzdC5pbmRleE9mKGZpbHRlclZhbHVlKSA+PSAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJldHVybiBvcHRpb25zO1xuXHRcdH1cblx0fSxcblxuXHRyZW5kZXJNZW51IChvcHRpb25zLCB2YWx1ZUFycmF5LCBmb2N1c2VkT3B0aW9uKSB7XG5cdFx0aWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5sZW5ndGgpIHtcblx0XHRcdGlmICh0aGlzLnByb3BzLm1lbnVSZW5kZXJlcikge1xuXHRcdFx0XHRyZXR1cm4gdGhpcy5wcm9wcy5tZW51UmVuZGVyZXIoe1xuXHRcdFx0XHRcdGZvY3VzZWRPcHRpb24sXG5cdFx0XHRcdFx0Zm9jdXNPcHRpb246IHRoaXMuZm9jdXNPcHRpb24sXG5cdFx0XHRcdFx0bGFiZWxLZXk6IHRoaXMucHJvcHMubGFiZWxLZXksXG5cdFx0XHRcdFx0b3B0aW9ucyxcblx0XHRcdFx0XHRzZWxlY3RWYWx1ZTogdGhpcy5zZWxlY3RWYWx1ZSxcblx0XHRcdFx0XHR2YWx1ZUFycmF5LFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGxldCBPcHRpb24gPSB0aGlzLnByb3BzLm9wdGlvbkNvbXBvbmVudDtcblx0XHRcdFx0bGV0IHJlbmRlckxhYmVsID0gdGhpcy5wcm9wcy5vcHRpb25SZW5kZXJlciB8fCB0aGlzLmdldE9wdGlvbkxhYmVsO1xuXG5cdFx0XHRcdHJldHVybiBvcHRpb25zLm1hcCgob3B0aW9uLCBpKSA9PiB7XG5cdFx0XHRcdFx0bGV0IGlzU2VsZWN0ZWQgPSB2YWx1ZUFycmF5ICYmIHZhbHVlQXJyYXkuaW5kZXhPZihvcHRpb24pID4gLTE7XG5cdFx0XHRcdFx0bGV0IGlzRm9jdXNlZCA9IG9wdGlvbiA9PT0gZm9jdXNlZE9wdGlvbjtcblx0XHRcdFx0XHRsZXQgb3B0aW9uUmVmID0gaXNGb2N1c2VkID8gJ2ZvY3VzZWQnIDogbnVsbDtcblx0XHRcdFx0XHRsZXQgb3B0aW9uQ2xhc3MgPSBjbGFzc05hbWVzKHRoaXMucHJvcHMub3B0aW9uQ2xhc3NOYW1lLCB7XG5cdFx0XHRcdFx0XHQnU2VsZWN0LW9wdGlvbic6IHRydWUsXG5cdFx0XHRcdFx0XHQnaXMtc2VsZWN0ZWQnOiBpc1NlbGVjdGVkLFxuXHRcdFx0XHRcdFx0J2lzLWZvY3VzZWQnOiBpc0ZvY3VzZWQsXG5cdFx0XHRcdFx0XHQnaXMtZGlzYWJsZWQnOiBvcHRpb24uZGlzYWJsZWQsXG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdFx0PE9wdGlvblxuXHRcdFx0XHRcdFx0XHRjbGFzc05hbWU9e29wdGlvbkNsYXNzfVxuXHRcdFx0XHRcdFx0XHRpc0Rpc2FibGVkPXtvcHRpb24uZGlzYWJsZWR9XG5cdFx0XHRcdFx0XHRcdGlzRm9jdXNlZD17aXNGb2N1c2VkfVxuXHRcdFx0XHRcdFx0XHRrZXk9e2BvcHRpb24tJHtpfS0ke29wdGlvblt0aGlzLnByb3BzLnZhbHVlS2V5XX1gfVxuXHRcdFx0XHRcdFx0XHRvblNlbGVjdD17dGhpcy5zZWxlY3RWYWx1ZX1cblx0XHRcdFx0XHRcdFx0b25Gb2N1cz17dGhpcy5mb2N1c09wdGlvbn1cblx0XHRcdFx0XHRcdFx0b3B0aW9uPXtvcHRpb259XG5cdFx0XHRcdFx0XHRcdGlzU2VsZWN0ZWQ9e2lzU2VsZWN0ZWR9XG5cdFx0XHRcdFx0XHRcdHJlZj17b3B0aW9uUmVmfVxuXHRcdFx0XHRcdFx0XHQ+XG5cdFx0XHRcdFx0XHRcdHtyZW5kZXJMYWJlbChvcHRpb24pfVxuXHRcdFx0XHRcdFx0PC9PcHRpb24+XG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmICh0aGlzLnByb3BzLm5vUmVzdWx0c1RleHQpIHtcblx0XHRcdHJldHVybiAoXG5cdFx0XHRcdDxkaXYgY2xhc3NOYW1lPVwiU2VsZWN0LW5vcmVzdWx0c1wiPlxuXHRcdFx0XHRcdHt0aGlzLnByb3BzLm5vUmVzdWx0c1RleHR9XG5cdFx0XHRcdDwvZGl2PlxuXHRcdFx0KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHR9LFxuXG5cdHJlbmRlckhpZGRlbkZpZWxkICh2YWx1ZUFycmF5KSB7XG5cdFx0aWYgKCF0aGlzLnByb3BzLm5hbWUpIHJldHVybjtcblx0XHRpZiAodGhpcy5wcm9wcy5qb2luVmFsdWVzKSB7XG5cdFx0XHRsZXQgdmFsdWUgPSB2YWx1ZUFycmF5Lm1hcChpID0+IHN0cmluZ2lmeVZhbHVlKGlbdGhpcy5wcm9wcy52YWx1ZUtleV0pKS5qb2luKHRoaXMucHJvcHMuZGVsaW1pdGVyKTtcblx0XHRcdHJldHVybiAoXG5cdFx0XHRcdDxpbnB1dFxuXHRcdFx0XHRcdHR5cGU9XCJoaWRkZW5cIlxuXHRcdFx0XHRcdHJlZj1cInZhbHVlXCJcblx0XHRcdFx0XHRuYW1lPXt0aGlzLnByb3BzLm5hbWV9XG5cdFx0XHRcdFx0dmFsdWU9e3ZhbHVlfVxuXHRcdFx0XHRcdGRpc2FibGVkPXt0aGlzLnByb3BzLmRpc2FibGVkfSAvPlxuXHRcdFx0KTtcblx0XHR9XG5cdFx0cmV0dXJuIHZhbHVlQXJyYXkubWFwKChpdGVtLCBpbmRleCkgPT4gKFxuXHRcdFx0PGlucHV0IGtleT17J2hpZGRlbi4nICsgaW5kZXh9XG5cdFx0XHRcdHR5cGU9XCJoaWRkZW5cIlxuXHRcdFx0XHRyZWY9eyd2YWx1ZScgKyBpbmRleH1cblx0XHRcdFx0bmFtZT17dGhpcy5wcm9wcy5uYW1lfVxuXHRcdFx0XHR2YWx1ZT17c3RyaW5naWZ5VmFsdWUoaXRlbVt0aGlzLnByb3BzLnZhbHVlS2V5XSl9XG5cdFx0XHRcdGRpc2FibGVkPXt0aGlzLnByb3BzLmRpc2FibGVkfSAvPlxuXHRcdCkpO1xuXHR9LFxuXG5cdGdldEZvY3VzYWJsZU9wdGlvbiAoc2VsZWN0ZWRPcHRpb24pIHtcblx0XHR2YXIgb3B0aW9ucyA9IHRoaXMuX3Zpc2libGVPcHRpb25zO1xuXHRcdGlmICghb3B0aW9ucy5sZW5ndGgpIHJldHVybjtcblx0XHRsZXQgZm9jdXNlZE9wdGlvbiA9IHRoaXMuc3RhdGUuZm9jdXNlZE9wdGlvbiB8fCBzZWxlY3RlZE9wdGlvbjtcblx0XHRpZiAoZm9jdXNlZE9wdGlvbiAmJiBvcHRpb25zLmluZGV4T2YoZm9jdXNlZE9wdGlvbikgPiAtMSkgcmV0dXJuIGZvY3VzZWRPcHRpb247XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBvcHRpb25zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRpZiAoIW9wdGlvbnNbaV0uZGlzYWJsZWQpIHJldHVybiBvcHRpb25zW2ldO1xuXHRcdH1cblx0fSxcblxuXHRyZW5kZXJPdXRlciAob3B0aW9ucywgdmFsdWVBcnJheSwgZm9jdXNlZE9wdGlvbikge1xuXHRcdGxldCBtZW51ID0gdGhpcy5yZW5kZXJNZW51KG9wdGlvbnMsIHZhbHVlQXJyYXksIGZvY3VzZWRPcHRpb24pO1xuXHRcdGlmICghbWVudSkge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIChcblx0XHRcdDxkaXYgcmVmPVwibWVudUNvbnRhaW5lclwiIGNsYXNzTmFtZT1cIlNlbGVjdC1tZW51LW91dGVyXCIgc3R5bGU9e3RoaXMucHJvcHMubWVudUNvbnRhaW5lclN0eWxlfT5cblx0XHRcdFx0PGRpdiByZWY9XCJtZW51XCIgY2xhc3NOYW1lPVwiU2VsZWN0LW1lbnVcIlxuXHRcdFx0XHRcdFx0IHN0eWxlPXt0aGlzLnByb3BzLm1lbnVTdHlsZX1cblx0XHRcdFx0XHRcdCBvblNjcm9sbD17dGhpcy5oYW5kbGVNZW51U2Nyb2xsfVxuXHRcdFx0XHRcdFx0IG9uTW91c2VEb3duPXt0aGlzLmhhbmRsZU1vdXNlRG93bk9uTWVudX0+XG5cdFx0XHRcdFx0e21lbnV9XG5cdFx0XHRcdDwvZGl2PlxuXHRcdFx0PC9kaXY+XG5cdFx0KTtcblx0fSxcblxuXHRyZW5kZXIgKCkge1xuXHRcdGxldCB2YWx1ZUFycmF5ID0gdGhpcy5nZXRWYWx1ZUFycmF5KCk7XG5cdFx0bGV0IG9wdGlvbnMgPSB0aGlzLl92aXNpYmxlT3B0aW9ucyA9IHRoaXMuZmlsdGVyT3B0aW9ucyh0aGlzLnByb3BzLm11bHRpID8gdmFsdWVBcnJheSA6IG51bGwpO1xuXHRcdGxldCBpc09wZW4gPSB0aGlzLnN0YXRlLmlzT3Blbjtcblx0XHRpZiAodGhpcy5wcm9wcy5tdWx0aSAmJiAhb3B0aW9ucy5sZW5ndGggJiYgdmFsdWVBcnJheS5sZW5ndGggJiYgIXRoaXMuc3RhdGUuaW5wdXRWYWx1ZSkgaXNPcGVuID0gZmFsc2U7XG5cdFx0bGV0IGZvY3VzZWRPcHRpb24gPSB0aGlzLl9mb2N1c2VkT3B0aW9uID0gdGhpcy5nZXRGb2N1c2FibGVPcHRpb24odmFsdWVBcnJheVswXSk7XG5cdFx0bGV0IGNsYXNzTmFtZSA9IGNsYXNzTmFtZXMoJ1NlbGVjdCcsIHRoaXMucHJvcHMuY2xhc3NOYW1lLCB7XG5cdFx0XHQnU2VsZWN0LS1tdWx0aSc6IHRoaXMucHJvcHMubXVsdGksXG5cdFx0XHQnaXMtZGlzYWJsZWQnOiB0aGlzLnByb3BzLmRpc2FibGVkLFxuXHRcdFx0J2lzLWZvY3VzZWQnOiB0aGlzLnN0YXRlLmlzRm9jdXNlZCxcblx0XHRcdCdpcy1sb2FkaW5nJzogdGhpcy5wcm9wcy5pc0xvYWRpbmcsXG5cdFx0XHQnaXMtb3Blbic6IGlzT3Blbixcblx0XHRcdCdpcy1wc2V1ZG8tZm9jdXNlZCc6IHRoaXMuc3RhdGUuaXNQc2V1ZG9Gb2N1c2VkLFxuXHRcdFx0J2lzLXNlYXJjaGFibGUnOiB0aGlzLnByb3BzLnNlYXJjaGFibGUsXG5cdFx0XHQnaGFzLXZhbHVlJzogdmFsdWVBcnJheS5sZW5ndGgsXG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gKFxuXHRcdFx0PGRpdiByZWY9XCJ3cmFwcGVyXCIgY2xhc3NOYW1lPXtjbGFzc05hbWV9IHN0eWxlPXt0aGlzLnByb3BzLndyYXBwZXJTdHlsZX0+XG5cdFx0XHRcdHt0aGlzLnJlbmRlckhpZGRlbkZpZWxkKHZhbHVlQXJyYXkpfVxuXHRcdFx0XHQ8ZGl2IHJlZj1cImNvbnRyb2xcIlxuXHRcdFx0XHRcdFx0IGNsYXNzTmFtZT1cIlNlbGVjdC1jb250cm9sXCJcblx0XHRcdFx0XHRcdCBzdHlsZT17dGhpcy5wcm9wcy5zdHlsZX1cblx0XHRcdFx0XHRcdCBvbktleURvd249e3RoaXMuaGFuZGxlS2V5RG93bn1cblx0XHRcdFx0XHRcdCBvbk1vdXNlRG93bj17dGhpcy5oYW5kbGVNb3VzZURvd259XG5cdFx0XHRcdFx0XHQgb25Ub3VjaEVuZD17dGhpcy5oYW5kbGVUb3VjaEVuZH1cblx0XHRcdFx0XHRcdCBvblRvdWNoU3RhcnQ9e3RoaXMuaGFuZGxlVG91Y2hTdGFydH1cblx0XHRcdFx0XHRcdCBvblRvdWNoTW92ZT17dGhpcy5oYW5kbGVUb3VjaE1vdmV9PlxuXHRcdFx0XHRcdHt0aGlzLnJlbmRlclZhbHVlKHZhbHVlQXJyYXksIGlzT3Blbil9XG5cdFx0XHRcdFx0e3RoaXMucmVuZGVySW5wdXQodmFsdWVBcnJheSl9XG5cdFx0XHRcdFx0e3RoaXMucmVuZGVyTG9hZGluZygpfVxuXHRcdFx0XHRcdHt0aGlzLnJlbmRlckNsZWFyKCl9XG5cdFx0XHRcdFx0e3RoaXMucmVuZGVyQXJyb3coKX1cblx0XHRcdFx0PC9kaXY+XG5cdFx0XHRcdHtpc09wZW4gPyB0aGlzLnJlbmRlck91dGVyKG9wdGlvbnMsICF0aGlzLnByb3BzLm11bHRpID8gdmFsdWVBcnJheSA6IG51bGwsIGZvY3VzZWRPcHRpb24pIDogbnVsbH1cblx0XHRcdDwvZGl2PlxuXHRcdCk7XG5cdH1cblxufSk7XG5cbmV4cG9ydCBkZWZhdWx0IFNlbGVjdDtcblxudmFyIERyYWdnYWJsZSA9IERyYWdnYWJsZVNlbGVjdChcbiAgRHJhZ0Ryb3BDb250ZXh0KEhUTUw1QmFja2VuZCkoU2VsZWN0KSxcbiAgRHJhZ2dhYmxlVmFsdWUoVmFsdWUpXG4pO1xuXG5leHBvcnQge0RyYWdnYWJsZSwgRHJhZ2dhYmxlU2VsZWN0LCBEcmFnZ2FibGVWYWx1ZX07XG4iXX0=
