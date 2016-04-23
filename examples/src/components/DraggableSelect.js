import React from 'react';
import Select from 'react-select';
import {Draggable} from 'react-select';

var DraggableSelect = React.createClass({
  displayName: 'DraggableSelect',
  propTypes: {
    label: React.PropTypes.string
  },
  getInitialState () {
    return {
      options: [
        { key: 10, title: 'Ten' },
        { key: 11, title: 'Eleven' },
        { key: 12, title: 'Twelve' },
        { key: 23, title: 'Twenty-three' },
        { key: 24, title: 'Twenty-four' }
      ],
      value: null
    };
  },
  onChange(value) {
    this.setState({ value });
    console.log('Select value changed to', value);
  },
  render () {
    return (
      <div className="section">
        <h3 className="section-heading">{this.props.label}</h3>
        <Draggable valueKey="key"
                   labelKey="title"
                   onChange={this.onChange}
                   value={this.state.value}
                   options={this.state.options} />
      </div>
    );
  }
});

module.exports = DraggableSelect;
