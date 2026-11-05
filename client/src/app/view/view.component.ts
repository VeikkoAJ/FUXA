import { Component, OnInit, AfterViewInit, OnDestroy, ViewChild, ChangeDetectorRef, ElementRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { GridsterConfig } from 'angular-gridster2';

import { ProjectService } from '../_services/project.service';
import { Hmi, View, ViewType, ZoomModeType } from '../_models/hmi';
import { GaugesManager } from '../gauges/gauges.component';
import { FuxaViewComponent } from '../fuxa-view/fuxa-view.component';
import { CardsViewComponent, GridOptions } from '../cards-view/cards-view.component';

import panzoom from 'panzoom';

@Component({
  selector: 'app-view',
  templateUrl: './view.component.html',
  styleUrls: ['./view.component.scss']
})
export class ViewComponent implements OnInit, AfterViewInit, OnDestroy {

    @ViewChild('fuxaview', {static: false}) fuxaview: FuxaViewComponent;
    @ViewChild('cardsview', {static: false}) cardsview: CardsViewComponent;
	@ViewChild('container', {read: ElementRef, static: true}) container: ElementRef;

    startView: View = new View();
    hmi: Hmi = new Hmi();
    cardViewType = ViewType.cards;
    mapsViewType = ViewType.maps;
    gridOptions = <GridsterConfig>new GridOptions();

    private viewName: string;

    private subscriptionLoad: Subscription;

    constructor(private projectService: ProjectService,
        private route: ActivatedRoute,
        private changeDetector: ChangeDetectorRef,
        public gaugesManager: GaugesManager) {
        this.gridOptions.draggable = { enabled: false };
        this.gridOptions.resizable = { enabled: false };
    }

    ngOnInit() {
        this.viewName = this.route.snapshot.queryParamMap.get('name');
    }

    ngAfterViewInit() {
        try {
            let hmi = this.projectService.getHmi();
            if (hmi) {
                this.loadHmi();
            }
            this.subscriptionLoad = this.projectService.onLoadHmi.subscribe(load => {
                this.loadHmi();
            }, error => {
                console.error('Error loadHMI');
            });
            this.changeDetector.detectChanges();
        }
        catch (err) {
            console.error(err);
        }
    }

    ngOnDestroy() {
        try {
            if (this.subscriptionLoad) {
                this.subscriptionLoad.unsubscribe();
            }
        } catch (e) {
        }
    }

    async onGoToPage(viewId: string) {
        if (!viewId || viewId === this.startView?.id) {
            return;
        }
        const view = await this.projectService.ensureViewLoaded(viewId);
        if (view) {
            this.showView(view);
        }
    }

    private async loadHmi() {
        let hmi = this.projectService.getHmi();
        if (hmi) {
            this.hmi = hmi;
        }
        if (this.hmi && this.hmi.views && this.hmi.views.length > 0) {
            const view = await this.projectService.ensureViewLoadedByName(this.viewName)
                ?? this.hmi.views.find(x => x.name === this.viewName);
            this.showView(view);
        }
    }

    private showView(view: View) {
        this.startView = view;
        // render the component matching the view type (svg, cards or maps)
        this.changeDetector.detectChanges();
        this.setBackground();
        if (!view) {
            return;
        }
        if (view.type === this.cardViewType || view.type === this.mapsViewType) {
            this.cardsview?.reload();
            return;
        }
        if (this.fuxaview) {
            this.fuxaview.loadHmi(view);
        }
        this.checkZoom();
    }

    private checkZoom() {
        if (this.hmi.layout && this.hmi.layout.zoom && ZoomModeType[this.hmi.layout.zoom] === ZoomModeType.enabled) {
            setTimeout(() => {
                let element: HTMLElement = document.querySelector('#view');
                if (element && panzoom) {
                    panzoom(element, {
                        bounds: true,
                        boundsPadding: 0.05,
                    });
                    this.container.nativeElement.style.overflow = 'hidden';
                }
            }, 1000);
        }
    }

    private setBackground() {
		if (this.startView && this.startView.profile) {
			document.getElementById('main-container').style.backgroundColor = this.startView.profile.bkcolor;
		}
	}
}
