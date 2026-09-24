import { Component, Input, OnInit } from '@angular/core';
import { ButtonActionMode, ButtonActionProperty, GaugeProperty } from '../../../../_models/hmi';

@Component({
    selector: 'button-action-property',
    templateUrl: './button-action-property.component.html',
    styleUrls: ['./button-action-property.component.scss']
})
export class ButtonActionPropertyComponent implements OnInit {

    static readonly MaxHoldTime = 10;

    @Input() property: GaugeProperty;

    modeType = ButtonActionMode;
    maxHoldTime = ButtonActionPropertyComponent.MaxHoldTime;

    ngOnInit() {
        this.property.buttonAction = <ButtonActionProperty>{
            mode: ButtonActionMode.none,
            offValue: '0',
            onValue: '1',
            pressValue: '1',
            releaseValue: '0',
            minHoldTime: 0,
            ...this.property.buttonAction
        };
    }

    get action(): ButtonActionProperty {
        return this.property.buttonAction;
    }

    onMinHoldTimeChange() {
        const value = Number(this.action.minHoldTime);
        this.action.minHoldTime = Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), this.maxHoldTime);
    }
}
