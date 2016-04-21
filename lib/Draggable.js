'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _react = require('react');

var _react2 = _interopRequireDefault(_react);

var _reactSelect = require('react-select');

var _reactSelect2 = _interopRequireDefault(_reactSelect);

var _classnames = require('classnames');

var _classnames2 = _interopRequireDefault(_classnames);

var _reactDnd = require('react-dnd');

var _reactDndHtml5Backend = require('react-dnd-html5-backend');

var _reactDndHtml5Backend2 = _interopRequireDefault(_reactDndHtml5Backend);

function ValueWrapper(moveItem) {

  var itemSource = {
    beginDrag: function beginDrag(props) {
      return { value: props.value };
    }
  };

  var itemTarget = {
    hover: function hover(props, monitor) {
      var draggedId = monitor.getItem().value;
      if (draggedId !== props.value) {
        moveItem(draggedId, props.value);
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

  var Value = (0, _reactDnd.DragSource)("DraggableSelect", itemSource, collectDrag)((0, _reactDnd.DropTarget)("DraggableSelect", itemTarget, collectDrop)(_react2['default'].createClass({
    propTypes: {
      children: _react2['default'].PropTypes.node,
      disabled: _react2['default'].PropTypes.bool, // disabled prop passed to ReactSelect
      onClick: _react2['default'].PropTypes.func, // method to handle click on value label
      onRemove: _react2['default'].PropTypes.func, // method to handle removal of the value
      value: _react2['default'].PropTypes.object.isRequired // the option object for this value
    },

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
      return _react2['default'].createElement(
        'span',
        { className: className, style: { maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' } },
        this.props.children
      );
    },

    render: function render() {
      var _props = this.props;
      var isDragging = _props.isDragging;
      var connectDragSource = _props.connectDragSource;
      var connectDropTarget = _props.connectDropTarget;

      return connectDragSource(connectDropTarget(_react2['default'].createElement(
        'div',
        { onMouseDown: function (e) {
            return e.stopPropagation();
          }, className: (0, _classnames2['default'])('Select-value', this.props.value.className),
          style: this.props.value.style,
          title: this.props.value.title },
        this.renderRemoveIcon(),
        this.renderLabel()
      )));
    }
  })));

  return Value;
}

var Draggable = _react2['default'].createClass({
  displayName: 'Draggable',

  moveItem: function moveItem(val, afterVal) {
    var _props2 = this.props;
    var onChange = _props2.onChange;
    var value = _props2.value;
    var item = val.value;
    var afterItem = afterVal.value;
    var itemIndex = value.indexOf(item);
    var afterIndex = value.indexOf(afterItem);
    var valueCopy = value.concat([]);

    valueCopy.splice(itemIndex, 1);
    valueCopy.splice(afterIndex, 0, item);

    onChange(valueCopy);
  },

  render: function render() {
    return _react2['default'].createElement(_reactSelect2['default'], _extends({}, this.props, {
      multi: true,
      valueComponent: ValueWrapper(this.moveItem) }));
  }
});

module.exports = (0, _reactDnd.DragDropContext)(_reactDndHtml5Backend2['default'])(Draggable);