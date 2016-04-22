import React from 'react';
import classNames from 'classnames';
import {DragSource, DropTarget} from 'react-dnd';

const itemSource = {
  beginDrag(props) {
    return {value: props.value};
  }
};

const itemTarget = {
  hover(props, monitor) {
    const item = monitor.getItem().value;
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

var DraggableValue = function(Component) {
  return (
    DragSource("DraggableSelect", itemSource, collectDrag)(
    DropTarget("DraggableSelect", itemTarget, collectDrop)(
      React.createClass({
        render() {
          const {connectDragSource, connectDropTarget, draggingOpacity, ...rest} = this.props;
          return connectDragSource(connectDropTarget(
            <span style={{opacity: draggingOpacity}}
                  onMouseDown={e => e.stopPropagation()}>
                    <Component {...rest} />
            </span>
          ));
        }
      })
    ))
  );
};

var DraggableSelect = function(Component, ValueComponent) {
  return React.createClass({
    moveItem(src, dest) {
      const {onChange, value} = this.props,
            values = value.map(d => d.value),
            srcIndex = values.indexOf(src.value),
            destIndex = values.indexOf(dest.value),
            valueCopy = value.concat([]);

      valueCopy.splice(srcIndex, 1);
      valueCopy.splice(destIndex, 0, src);

      onChange(valueCopy);
    },

  	render() {
  		return (
  			<Component {...this.props}
  				multi={true}
          moveItem={this.moveItem}
          valueComponent={ValueComponent} />
  		);
  	}
  });
};

export {DraggableSelect, DraggableValue};
