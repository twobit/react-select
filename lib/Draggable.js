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