'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

function _objectWithoutProperties(obj, keys) { var target = {}; for (var i in obj) { if (keys.indexOf(i) >= 0) continue; if (!Object.prototype.hasOwnProperty.call(obj, i)) continue; target[i] = obj[i]; } return target; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _reactDnd = require('react-dnd');

var _classnames = require('classnames');

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