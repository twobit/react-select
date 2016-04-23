(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.Select = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
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
  if ("production" !== 'production') {
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

},{}],89:[function(require,module,exports){
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
arguments[4][68][0].apply(exports,arguments)
},{"./_checkGlobal":128,"dup":68}],154:[function(require,module,exports){
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
(function (global){
'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = (typeof window !== "undefined" ? window['React'] : typeof global !== "undefined" ? global['React'] : null);

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

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./Select":214,"./utils/stripDiacritics":216}],212:[function(require,module,exports){
(function (global){
'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _objectWithoutProperties(obj, keys) { var target = {}; for (var i in obj) { if (keys.indexOf(i) >= 0) continue; if (!Object.prototype.hasOwnProperty.call(obj, i)) continue; target[i] = obj[i]; } return target; }

var _react = (typeof window !== "undefined" ? window['React'] : typeof global !== "undefined" ? global['React'] : null);

var _react2 = _interopRequireDefault(_react);

var _reactDnd = require('react-dnd');

var _classnames = (typeof window !== "undefined" ? window['classNames'] : typeof global !== "undefined" ? global['classNames'] : null);

var _classnames2 = _interopRequireDefault(_classnames);

var itemSource = {
  beginDrag: function beginDrag(props) {
    return props.value;
  }
};

var itemTarget = {
  hover: function hover(props, monitor) {
    var item = monitor.getItem();
    if (item !== props.value) {
      props.onChangeLayout(item, props.value);
    }
  }
};

function collectDrag(connect, monitor) {
  return {
    connectDragSource: connect.dragSource(),
    isDragging: monitor.isDragging()
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
      var isDragging = _props.isDragging;

      var rest = _objectWithoutProperties(_props, ['connectDragSource', 'connectDropTarget', 'isDragging']);

      return connectDragSource(connectDropTarget(_react2['default'].createElement(
        'span',
        { style: { opacity: isDragging ? 0.3 : null },
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
    getDefaultProps: function getDefaultProps() {
      return {
        valueKey: 'value'
      };
    },

    onChangeLayout: function onChangeLayout(src, dest) {
      var _props2 = this.props;
      var value = _props2.value;
      var valueKey = _props2.valueKey;
      var onChange = _props2.onChange;
      var values = value.map(function (d) {
        return d[valueKey];
      });
      var srcIndex = values.indexOf(src[valueKey]);
      var destIndex = values.indexOf(dest[valueKey]);
      var newValue = value.concat([]);

      newValue.splice(srcIndex, 1);
      newValue.splice(destIndex, 0, src);
      onChange(newValue);
    },

    render: function render() {
      return _react2['default'].createElement(Component, _extends({}, this.props, {
        multi: true,
        onChangeLayout: this.onChangeLayout,
        valueComponent: ValueComponent }));
    }
  });
};

exports.DraggableSelect = DraggableSelect;
exports.DraggableValue = DraggableValue;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"react-dnd":190}],213:[function(require,module,exports){
(function (global){
'use strict';

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = (typeof window !== "undefined" ? window['React'] : typeof global !== "undefined" ? global['React'] : null);

var _react2 = _interopRequireDefault(_react);

var _classnames = (typeof window !== "undefined" ? window['classNames'] : typeof global !== "undefined" ? global['classNames'] : null);

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

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],214:[function(require,module,exports){
(function (global){
'use strict';

Object.defineProperty(exports, '__esModule', {
	value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = (typeof window !== "undefined" ? window['React'] : typeof global !== "undefined" ? global['React'] : null);

var _react2 = _interopRequireDefault(_react);

var _reactDom = (typeof window !== "undefined" ? window['ReactDOM'] : typeof global !== "undefined" ? global['ReactDOM'] : null);

var _reactDom2 = _interopRequireDefault(_reactDom);

var _reactInputAutosize = (typeof window !== "undefined" ? window['AutosizeInput'] : typeof global !== "undefined" ? global['AutosizeInput'] : null);

var _reactInputAutosize2 = _interopRequireDefault(_reactInputAutosize);

var _classnames = (typeof window !== "undefined" ? window['classNames'] : typeof global !== "undefined" ? global['classNames'] : null);

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
						onChangeLayout: _this2.props.onChangeLayout,
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
exports.Value = _Value2['default'];

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./Async":211,"./Draggable":212,"./Option":213,"./Value":215,"./utils/stripDiacritics":216,"react-dnd":190,"react-dnd-html5-backend":98}],215:[function(require,module,exports){
(function (global){
'use strict';

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = (typeof window !== "undefined" ? window['React'] : typeof global !== "undefined" ? global['React'] : null);

var _react2 = _interopRequireDefault(_react);

var _classnames = (typeof window !== "undefined" ? window['classNames'] : typeof global !== "undefined" ? global['classNames'] : null);

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

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],216:[function(require,module,exports){
'use strict';

var map = [{ 'base': 'A', 'letters': /[\u0041\u24B6\uFF21\u00C0\u00C1\u00C2\u1EA6\u1EA4\u1EAA\u1EA8\u00C3\u0100\u0102\u1EB0\u1EAE\u1EB4\u1EB2\u0226\u01E0\u00C4\u01DE\u1EA2\u00C5\u01FA\u01CD\u0200\u0202\u1EA0\u1EAC\u1EB6\u1E00\u0104\u023A\u2C6F]/g }, { 'base': 'AA', 'letters': /[\uA732]/g }, { 'base': 'AE', 'letters': /[\u00C6\u01FC\u01E2]/g }, { 'base': 'AO', 'letters': /[\uA734]/g }, { 'base': 'AU', 'letters': /[\uA736]/g }, { 'base': 'AV', 'letters': /[\uA738\uA73A]/g }, { 'base': 'AY', 'letters': /[\uA73C]/g }, { 'base': 'B', 'letters': /[\u0042\u24B7\uFF22\u1E02\u1E04\u1E06\u0243\u0182\u0181]/g }, { 'base': 'C', 'letters': /[\u0043\u24B8\uFF23\u0106\u0108\u010A\u010C\u00C7\u1E08\u0187\u023B\uA73E]/g }, { 'base': 'D', 'letters': /[\u0044\u24B9\uFF24\u1E0A\u010E\u1E0C\u1E10\u1E12\u1E0E\u0110\u018B\u018A\u0189\uA779]/g }, { 'base': 'DZ', 'letters': /[\u01F1\u01C4]/g }, { 'base': 'Dz', 'letters': /[\u01F2\u01C5]/g }, { 'base': 'E', 'letters': /[\u0045\u24BA\uFF25\u00C8\u00C9\u00CA\u1EC0\u1EBE\u1EC4\u1EC2\u1EBC\u0112\u1E14\u1E16\u0114\u0116\u00CB\u1EBA\u011A\u0204\u0206\u1EB8\u1EC6\u0228\u1E1C\u0118\u1E18\u1E1A\u0190\u018E]/g }, { 'base': 'F', 'letters': /[\u0046\u24BB\uFF26\u1E1E\u0191\uA77B]/g }, { 'base': 'G', 'letters': /[\u0047\u24BC\uFF27\u01F4\u011C\u1E20\u011E\u0120\u01E6\u0122\u01E4\u0193\uA7A0\uA77D\uA77E]/g }, { 'base': 'H', 'letters': /[\u0048\u24BD\uFF28\u0124\u1E22\u1E26\u021E\u1E24\u1E28\u1E2A\u0126\u2C67\u2C75\uA78D]/g }, { 'base': 'I', 'letters': /[\u0049\u24BE\uFF29\u00CC\u00CD\u00CE\u0128\u012A\u012C\u0130\u00CF\u1E2E\u1EC8\u01CF\u0208\u020A\u1ECA\u012E\u1E2C\u0197]/g }, { 'base': 'J', 'letters': /[\u004A\u24BF\uFF2A\u0134\u0248]/g }, { 'base': 'K', 'letters': /[\u004B\u24C0\uFF2B\u1E30\u01E8\u1E32\u0136\u1E34\u0198\u2C69\uA740\uA742\uA744\uA7A2]/g }, { 'base': 'L', 'letters': /[\u004C\u24C1\uFF2C\u013F\u0139\u013D\u1E36\u1E38\u013B\u1E3C\u1E3A\u0141\u023D\u2C62\u2C60\uA748\uA746\uA780]/g }, { 'base': 'LJ', 'letters': /[\u01C7]/g }, { 'base': 'Lj', 'letters': /[\u01C8]/g }, { 'base': 'M', 'letters': /[\u004D\u24C2\uFF2D\u1E3E\u1E40\u1E42\u2C6E\u019C]/g }, { 'base': 'N', 'letters': /[\u004E\u24C3\uFF2E\u01F8\u0143\u00D1\u1E44\u0147\u1E46\u0145\u1E4A\u1E48\u0220\u019D\uA790\uA7A4]/g }, { 'base': 'NJ', 'letters': /[\u01CA]/g }, { 'base': 'Nj', 'letters': /[\u01CB]/g }, { 'base': 'O', 'letters': /[\u004F\u24C4\uFF2F\u00D2\u00D3\u00D4\u1ED2\u1ED0\u1ED6\u1ED4\u00D5\u1E4C\u022C\u1E4E\u014C\u1E50\u1E52\u014E\u022E\u0230\u00D6\u022A\u1ECE\u0150\u01D1\u020C\u020E\u01A0\u1EDC\u1EDA\u1EE0\u1EDE\u1EE2\u1ECC\u1ED8\u01EA\u01EC\u00D8\u01FE\u0186\u019F\uA74A\uA74C]/g }, { 'base': 'OI', 'letters': /[\u01A2]/g }, { 'base': 'OO', 'letters': /[\uA74E]/g }, { 'base': 'OU', 'letters': /[\u0222]/g }, { 'base': 'P', 'letters': /[\u0050\u24C5\uFF30\u1E54\u1E56\u01A4\u2C63\uA750\uA752\uA754]/g }, { 'base': 'Q', 'letters': /[\u0051\u24C6\uFF31\uA756\uA758\u024A]/g }, { 'base': 'R', 'letters': /[\u0052\u24C7\uFF32\u0154\u1E58\u0158\u0210\u0212\u1E5A\u1E5C\u0156\u1E5E\u024C\u2C64\uA75A\uA7A6\uA782]/g }, { 'base': 'S', 'letters': /[\u0053\u24C8\uFF33\u1E9E\u015A\u1E64\u015C\u1E60\u0160\u1E66\u1E62\u1E68\u0218\u015E\u2C7E\uA7A8\uA784]/g }, { 'base': 'T', 'letters': /[\u0054\u24C9\uFF34\u1E6A\u0164\u1E6C\u021A\u0162\u1E70\u1E6E\u0166\u01AC\u01AE\u023E\uA786]/g }, { 'base': 'TZ', 'letters': /[\uA728]/g }, { 'base': 'U', 'letters': /[\u0055\u24CA\uFF35\u00D9\u00DA\u00DB\u0168\u1E78\u016A\u1E7A\u016C\u00DC\u01DB\u01D7\u01D5\u01D9\u1EE6\u016E\u0170\u01D3\u0214\u0216\u01AF\u1EEA\u1EE8\u1EEE\u1EEC\u1EF0\u1EE4\u1E72\u0172\u1E76\u1E74\u0244]/g }, { 'base': 'V', 'letters': /[\u0056\u24CB\uFF36\u1E7C\u1E7E\u01B2\uA75E\u0245]/g }, { 'base': 'VY', 'letters': /[\uA760]/g }, { 'base': 'W', 'letters': /[\u0057\u24CC\uFF37\u1E80\u1E82\u0174\u1E86\u1E84\u1E88\u2C72]/g }, { 'base': 'X', 'letters': /[\u0058\u24CD\uFF38\u1E8A\u1E8C]/g }, { 'base': 'Y', 'letters': /[\u0059\u24CE\uFF39\u1EF2\u00DD\u0176\u1EF8\u0232\u1E8E\u0178\u1EF6\u1EF4\u01B3\u024E\u1EFE]/g }, { 'base': 'Z', 'letters': /[\u005A\u24CF\uFF3A\u0179\u1E90\u017B\u017D\u1E92\u1E94\u01B5\u0224\u2C7F\u2C6B\uA762]/g }, { 'base': 'a', 'letters': /[\u0061\u24D0\uFF41\u1E9A\u00E0\u00E1\u00E2\u1EA7\u1EA5\u1EAB\u1EA9\u00E3\u0101\u0103\u1EB1\u1EAF\u1EB5\u1EB3\u0227\u01E1\u00E4\u01DF\u1EA3\u00E5\u01FB\u01CE\u0201\u0203\u1EA1\u1EAD\u1EB7\u1E01\u0105\u2C65\u0250]/g }, { 'base': 'aa', 'letters': /[\uA733]/g }, { 'base': 'ae', 'letters': /[\u00E6\u01FD\u01E3]/g }, { 'base': 'ao', 'letters': /[\uA735]/g }, { 'base': 'au', 'letters': /[\uA737]/g }, { 'base': 'av', 'letters': /[\uA739\uA73B]/g }, { 'base': 'ay', 'letters': /[\uA73D]/g }, { 'base': 'b', 'letters': /[\u0062\u24D1\uFF42\u1E03\u1E05\u1E07\u0180\u0183\u0253]/g }, { 'base': 'c', 'letters': /[\u0063\u24D2\uFF43\u0107\u0109\u010B\u010D\u00E7\u1E09\u0188\u023C\uA73F\u2184]/g }, { 'base': 'd', 'letters': /[\u0064\u24D3\uFF44\u1E0B\u010F\u1E0D\u1E11\u1E13\u1E0F\u0111\u018C\u0256\u0257\uA77A]/g }, { 'base': 'dz', 'letters': /[\u01F3\u01C6]/g }, { 'base': 'e', 'letters': /[\u0065\u24D4\uFF45\u00E8\u00E9\u00EA\u1EC1\u1EBF\u1EC5\u1EC3\u1EBD\u0113\u1E15\u1E17\u0115\u0117\u00EB\u1EBB\u011B\u0205\u0207\u1EB9\u1EC7\u0229\u1E1D\u0119\u1E19\u1E1B\u0247\u025B\u01DD]/g }, { 'base': 'f', 'letters': /[\u0066\u24D5\uFF46\u1E1F\u0192\uA77C]/g }, { 'base': 'g', 'letters': /[\u0067\u24D6\uFF47\u01F5\u011D\u1E21\u011F\u0121\u01E7\u0123\u01E5\u0260\uA7A1\u1D79\uA77F]/g }, { 'base': 'h', 'letters': /[\u0068\u24D7\uFF48\u0125\u1E23\u1E27\u021F\u1E25\u1E29\u1E2B\u1E96\u0127\u2C68\u2C76\u0265]/g }, { 'base': 'hv', 'letters': /[\u0195]/g }, { 'base': 'i', 'letters': /[\u0069\u24D8\uFF49\u00EC\u00ED\u00EE\u0129\u012B\u012D\u00EF\u1E2F\u1EC9\u01D0\u0209\u020B\u1ECB\u012F\u1E2D\u0268\u0131]/g }, { 'base': 'j', 'letters': /[\u006A\u24D9\uFF4A\u0135\u01F0\u0249]/g }, { 'base': 'k', 'letters': /[\u006B\u24DA\uFF4B\u1E31\u01E9\u1E33\u0137\u1E35\u0199\u2C6A\uA741\uA743\uA745\uA7A3]/g }, { 'base': 'l', 'letters': /[\u006C\u24DB\uFF4C\u0140\u013A\u013E\u1E37\u1E39\u013C\u1E3D\u1E3B\u017F\u0142\u019A\u026B\u2C61\uA749\uA781\uA747]/g }, { 'base': 'lj', 'letters': /[\u01C9]/g }, { 'base': 'm', 'letters': /[\u006D\u24DC\uFF4D\u1E3F\u1E41\u1E43\u0271\u026F]/g }, { 'base': 'n', 'letters': /[\u006E\u24DD\uFF4E\u01F9\u0144\u00F1\u1E45\u0148\u1E47\u0146\u1E4B\u1E49\u019E\u0272\u0149\uA791\uA7A5]/g }, { 'base': 'nj', 'letters': /[\u01CC]/g }, { 'base': 'o', 'letters': /[\u006F\u24DE\uFF4F\u00F2\u00F3\u00F4\u1ED3\u1ED1\u1ED7\u1ED5\u00F5\u1E4D\u022D\u1E4F\u014D\u1E51\u1E53\u014F\u022F\u0231\u00F6\u022B\u1ECF\u0151\u01D2\u020D\u020F\u01A1\u1EDD\u1EDB\u1EE1\u1EDF\u1EE3\u1ECD\u1ED9\u01EB\u01ED\u00F8\u01FF\u0254\uA74B\uA74D\u0275]/g }, { 'base': 'oi', 'letters': /[\u01A3]/g }, { 'base': 'ou', 'letters': /[\u0223]/g }, { 'base': 'oo', 'letters': /[\uA74F]/g }, { 'base': 'p', 'letters': /[\u0070\u24DF\uFF50\u1E55\u1E57\u01A5\u1D7D\uA751\uA753\uA755]/g }, { 'base': 'q', 'letters': /[\u0071\u24E0\uFF51\u024B\uA757\uA759]/g }, { 'base': 'r', 'letters': /[\u0072\u24E1\uFF52\u0155\u1E59\u0159\u0211\u0213\u1E5B\u1E5D\u0157\u1E5F\u024D\u027D\uA75B\uA7A7\uA783]/g }, { 'base': 's', 'letters': /[\u0073\u24E2\uFF53\u00DF\u015B\u1E65\u015D\u1E61\u0161\u1E67\u1E63\u1E69\u0219\u015F\u023F\uA7A9\uA785\u1E9B]/g }, { 'base': 't', 'letters': /[\u0074\u24E3\uFF54\u1E6B\u1E97\u0165\u1E6D\u021B\u0163\u1E71\u1E6F\u0167\u01AD\u0288\u2C66\uA787]/g }, { 'base': 'tz', 'letters': /[\uA729]/g }, { 'base': 'u', 'letters': /[\u0075\u24E4\uFF55\u00F9\u00FA\u00FB\u0169\u1E79\u016B\u1E7B\u016D\u00FC\u01DC\u01D8\u01D6\u01DA\u1EE7\u016F\u0171\u01D4\u0215\u0217\u01B0\u1EEB\u1EE9\u1EEF\u1EED\u1EF1\u1EE5\u1E73\u0173\u1E77\u1E75\u0289]/g }, { 'base': 'v', 'letters': /[\u0076\u24E5\uFF56\u1E7D\u1E7F\u028B\uA75F\u028C]/g }, { 'base': 'vy', 'letters': /[\uA761]/g }, { 'base': 'w', 'letters': /[\u0077\u24E6\uFF57\u1E81\u1E83\u0175\u1E87\u1E85\u1E98\u1E89\u2C73]/g }, { 'base': 'x', 'letters': /[\u0078\u24E7\uFF58\u1E8B\u1E8D]/g }, { 'base': 'y', 'letters': /[\u0079\u24E8\uFF59\u1EF3\u00FD\u0177\u1EF9\u0233\u1E8F\u00FF\u1EF7\u1E99\u1EF5\u01B4\u024F\u1EFF]/g }, { 'base': 'z', 'letters': /[\u007A\u24E9\uFF5A\u017A\u1E91\u017C\u017E\u1E93\u1E95\u01B6\u0225\u0240\u2C6C\uA763]/g }];

module.exports = function stripDiacritics(str) {
	for (var i = 0; i < map.length; i++) {
		str = str.replace(map[i].letters, map[i].base);
	}
	return str;
};

},{}]},{},[214])(214)
});