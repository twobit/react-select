import React from 'react';
import Select from 'react-select';
import classNames from 'classnames';
import {DragSource, DropTarget, DragDropContext} from 'react-dnd';
import HTML5Backend from 'react-dnd-html5-backend';


function ValueWrapper(moveItem) {

const itemSource = {
  beginDrag(props) {
    return {value: props.value};
  }
};

const itemTarget = {
  hover(props, monitor) {
    const draggedId = monitor.getItem().value;
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

var Value = DragSource("DraggableSelect", itemSource, collectDrag)(
              DropTarget("DraggableSelect", itemTarget, collectDrop)(
                React.createClass({
  propTypes: {
    children: React.PropTypes.node,
    disabled: React.PropTypes.bool,               // disabled prop passed to ReactSelect
    onClick: React.PropTypes.func,                // method to handle click on value label
    onRemove: React.PropTypes.func,               // method to handle removal of the value
    value: React.PropTypes.object.isRequired      // the option object for this value
  },

  handleMouseDown(event) {
    if (event.type === 'mousedown' && event.button !== 0) {return;}

    if (this.props.onClick) {
      event.stopPropagation();
      this.props.onClick(this.props.value, event);
      return;
    }

    if (this.props.value.href) {
      event.stopPropagation();
    }
  },

  onRemove(event) {
    event.preventDefault();
    event.stopPropagation();
    this.props.onRemove(this.props.value);
  },

  handleTouchEndRemove(event) {
    // Check if the view is being dragged, In this case
    // we don't want to fire the click event (because the user only wants to scroll)
    if(this.dragging) return;

    // Fire the mouse events
    this.onRemove(event);
  },

  handleTouchMove(event) {
    // Set a flag that the view is being dragged
    this.dragging = true;
  },

  handleTouchStart(event) {
    // Set a flag that the view is not being dragged
    this.dragging = false;
  },

  renderRemoveIcon() {
    if (this.props.disabled || !this.props.onRemove) return;
    return (
      <span className="Select-value-icon"
        onMouseDown={this.onRemove}
        onTouchEnd={this.handleTouchEndRemove}
        onTouchStart={this.handleTouchStart}
        onTouchMove={this.handleTouchMove}>
        &times;
      </span>
    );
  },

  renderLabel() {
    let className = 'Select-value-label';
    return (
      <span className={className} style={{maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
        {this.props.children}
      </span>
    );
  },

  render() {
    const {isDragging, connectDragSource, connectDropTarget} = this.props;
    return connectDragSource(connectDropTarget(
      <div onMouseDown={e => e.stopPropagation()} className={classNames('Select-value', this.props.value.className)}
           style={this.props.value.style}
           title={this.props.value.title}>
           {this.renderRemoveIcon()}
           {this.renderLabel()}
      </div>
    ));
  }
})));

return Value;
}

var DraggableSelect = React.createClass({
	displayName: 'DraggableSelect',
	propTypes: {
		label: React.PropTypes.string
	},
	getInitialState () {
		return {
			options: [
				{ value: 10, label: 'Ten' },
				{ value: 11, label: 'Eleven' },
				{ value: 12, label: 'Twelve' },
				{ value: 23, label: 'Twenty-three' },
				{ value: 24, label: 'Twenty-four' }
			],
			value: null
		};
	},
	onChange(value) {
		this.setState({ value });
		console.log('Select value changed to', value);
	},
  moveItem(val, afterVal) {
    const {value} = this.state,
          {onChange} = this.props,
          item = val.value,
          afterItem = afterVal.value,
          itemIndex = value.indexOf(item),
          afterIndex = value.indexOf(afterItem),
          valueCopy = value.concat([]);

    valueCopy.splice(itemIndex, 1);
    valueCopy.splice(afterIndex, 0, item);

    this.onChange(valueCopy);
  },
	render () {
		return (
			<div className="section">
				<h3 className="section-heading">{this.props.label}</h3>
				<Select
					multi={true}
					onChange={this.onChange}
					value={this.state.value}
          options={this.state.options}
          valueComponent={ValueWrapper(this.moveItem)}
					/>
      </div>
		);
	}
});

module.exports = DragDropContext(HTML5Backend)(DraggableSelect);
