import React from 'react';
import {DragSource, DropTarget} from 'react-dnd';
import classNames from 'classnames';

const itemSource = {
  beginDrag(props) {
    return props.value;
  }
};

const itemTarget = {
  hover(props, monitor) {
    const item = monitor.getItem();
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

var DraggableValue = function(Component) {
  return (
    DragSource("DraggableSelect", itemSource, collectDrag)(
    DropTarget("DraggableSelect", itemTarget, collectDrop)(
      React.createClass({
        render() {
          const {connectDragSource, connectDropTarget, isDragging, ...rest} = this.props;
          return connectDragSource(connectDropTarget(
            <span style={{opacity: isDragging ? 0.3 : null}}
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
  	getDefaultProps () {
  		return {
			  valueKey: 'value'
      };
    },

    onChangeLayout(src, dest) {
      const {value, valueKey, onChange} = this.props,
            values = value.map(d => d[valueKey]),
            srcIndex = values.indexOf(src[valueKey]),
            destIndex = values.indexOf(dest[valueKey]),
            newValue = value.concat([]);

      newValue.splice(srcIndex, 1);
      newValue.splice(destIndex, 0, src);
      onChange(newValue);
    },

  	render() {
  		return (
  			<Component {...this.props}
  				multi={true}
          onChangeLayout={this.onChangeLayout}
          valueComponent={ValueComponent} />
  		);
  	}
  });
};

export {DraggableSelect, DraggableValue};
