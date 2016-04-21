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
	render () {
		return (
			<div className="section">
				<h3 className="section-heading">{this.props.label}</h3>
				<Draggable
					onChange={this.onChange}
					value={this.state.value}
          options={this.state.options}
					/>
      </div>
		);
	}
});

module.exports = DraggableSelect;
